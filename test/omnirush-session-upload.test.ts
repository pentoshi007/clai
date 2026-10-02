import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmnirushCliSessionUploader,
  bindOmnirushSessionUpload,
  isOmnirushSessionUploadEnabled,
  type OmnirushSessionSource,
  type OmnirushSessionState,
} from "../src/llm/omnirush-session-upload.js";

type UploadCall = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly source: string;
};

class TestSessionSource implements OmnirushSessionSource {
  private readonly turnListeners = new Set<(result: { readonly status: string }) => void>();
  private readonly stateListeners = new Set<() => void>();

  constructor(private state: OmnirushSessionState) {}

  getState(): OmnirushSessionState {
    return this.state;
  }

  onTurnEnd(listener: (result: { readonly status: string }) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  subscribe(listener: () => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  finishTurn(status = "completed"): void {
    for (const listener of this.turnListeners) listener({ status });
  }

  setState(state: OmnirushSessionState): void {
    this.state = state;
    for (const listener of this.stateListeners) listener();
  }
}

afterEach(() => {
  delete process.env.CLAI_OMNIRUSH_SESSION_UPLOAD;
});

describe("OmniRush CLI session upload", () => {
  it("creates and uploads synthetic source for each session event", async () => {
    const root = mkdtempSync(join(tmpdir(), "clai-omnirush-upload-"));
    const workspace = join(root, "workspace");
    const calls: UploadCall[] = [];
    try {
      const uploader = new OmnirushCliSessionUploader({
        sessionId: "sess-123",
        workspaceDir: workspace,
        command: "/opt/omnirush",
        now: () => new Date("2026-10-02T06:00:00.000Z"),
        runner: async (command, args, options) => {
          calls.push({
            command,
            args: [...args],
            cwd: options.cwd,
            source: readFileSync(join(workspace, "src", "clai-session.ts"), "utf8"),
          });
          return { exitCode: 0 };
        },
      });

      await uploader.recordTurn("completed");
      await uploader.close();

      expect(calls).toHaveLength(2);
      expect(calls.map((call) => call.command)).toEqual(["/opt/omnirush", "/opt/omnirush"]);
      expect(calls.map((call) => call.args)).toEqual([
        ["upload", "--dir", workspace, "--yes"],
        ["upload", "--dir", workspace, "--yes"],
      ]);
      expect(calls.map((call) => call.cwd)).toEqual([workspace, workspace]);
      expect(calls[0]?.source).toContain('"phase":"turn_completed"');
      expect(calls[1]?.source).toContain('"phase":"session_end"');
      expect(calls[1]?.source).toContain('"session_id":"sess-123"');
      expect(calls[1]?.source).not.toContain("prompt");
      expect(JSON.parse(readFileSync(join(workspace, "package.json"), "utf8"))).toMatchObject({
        name: "clai-omnirush-session",
        private: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a rejected OmniRush login without exposing CLI output", async () => {
    const root = mkdtempSync(join(tmpdir(), "clai-omnirush-auth-"));
    const reports: string[] = [];
    try {
      const uploader = new OmnirushCliSessionUploader({
        sessionId: "sess-auth",
        workspaceDir: join(root, "workspace"),
        report: (message) => reports.push(message),
        runner: async () => ({
          exitCode: 1,
          output: "upload rejected as unauthorized {\"status\":401}",
        }),
      });

      await uploader.recordTurn("completed");

      expect(reports).toEqual([
        "OmniRush session upload needs a fresh OmniRush CLI login; run `omnirush login`",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("binds completed OmniRush turns to the CLI uploader", async () => {
    const root = mkdtempSync(join(tmpdir(), "clai-omnirush-bind-"));
    const source = new TestSessionSource({
      sessionId: "sess-bound",
      provider: "omnirush",
      model: "gpt-6-astra",
    });
    const calls: string[] = [];
    try {
      const binding = bindOmnirushSessionUpload({
        source,
        workspaceDir: (sessionId) => join(root, sessionId),
        runner: async (_command, _args, options) => {
          calls.push(readFileSync(join(options.cwd, "src", "clai-session.ts"), "utf8"));
          return { exitCode: 0 };
        },
      });

      source.finishTurn();
      await binding.close();

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('"status":"completed"');
      expect(calls[1]).toContain('"phase":"session_end"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not activate for non-OmniRush, no-history, or opted-out sessions", () => {
    const state: OmnirushSessionState = {
      sessionId: "sess-gate",
      provider: "omnirush",
      model: "gpt-6-astra",
    };

    expect(isOmnirushSessionUploadEnabled(state)).toBe(true);
    expect(isOmnirushSessionUploadEnabled({ ...state, provider: "openai" })).toBe(false);
    expect(isOmnirushSessionUploadEnabled(state, true)).toBe(false);
    process.env.CLAI_OMNIRUSH_SESSION_UPLOAD = "off";
    expect(isOmnirushSessionUploadEnabled(state)).toBe(false);
  });
});
