import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentPort } from "../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import { detectCapabilities } from "../src/ui-core/bootstrap/capabilities.js";
import {
  RendererLifecycle,
  type ProcessLike,
  type RendererHandle,
} from "../src/ui-core/bootstrap/lifecycle.js";

const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
  "CLAI_SESSION_WORKSPACE_DIR",
] as const;

const tmpEnvKeys = ["TMPDIR", "TMP", "TEMP"] as const;

let dataDir: string;
let originalEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;
let originalTmp: Partial<Record<(typeof tmpEnvKeys)[number], string | undefined>>;

let createCompositionRoot: typeof import("../src/ui-core/bootstrap/composition-root.js")["createCompositionRoot"];
let createExitEpilogue: typeof import("../src/ui-core/bootstrap/exit-epilogue.js")["createExitEpilogue"];

beforeEach(async () => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  originalTmp = {};
  for (const key of tmpEnvKeys) originalTmp[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-exit-epilogue-"));
  for (const key of dataEnvKeys) process.env[key] = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_SESSION_WORKSPACE_DIR = join(dataDir, "clai");
  // Session workspaces live under os.tmpdir(); keep them inside dataDir so this
  // test cleans up after itself instead of piling up in the shared temp root.
  for (const key of tmpEnvKeys) process.env[key] = dataDir;
  vi.resetModules();
  const [composition, epilogue] = await Promise.all([
    import("../src/ui-core/bootstrap/composition-root.js"),
    import("../src/ui-core/bootstrap/exit-epilogue.js"),
  ]);
  createCompositionRoot = composition.createCompositionRoot;
  createExitEpilogue = epilogue.createExitEpilogue;
});

afterEach(async () => {
  for (const key of dataEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of tmpEnvKeys) {
    const value = originalTmp[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  vi.resetModules();
});

function scriptedAgent(answer: string): AgentPort {
  return {
    async runTurn(request, handlers) {
      handlers.onEvent({ type: "turn-start", prompt: request.prompt });
      handlers.onEvent({
        type: "token-usage",
        provider: "nvidia" as never,
        model: "test-model",
        usage: {
          promptTokens: 1200,
          completionTokens: 340,
          totalTokens: 1540,
          exact: true,
          cachedPromptTokens: 300,
        },
      });
      handlers.onEvent({ type: "assistant-message", text: answer });
      handlers.onMessages?.([
        ...(request.history ?? []),
        { role: "user", content: request.prompt },
        { role: "assistant", content: answer },
      ]);
      const outcome = createTurnOutcome({
        status: "succeeded",
        answer,
        steps: 0,
        remainingCriteria: [],
      });
      handlers.onEvent({ type: "turn-end", outcome, finalAnswer: answer, steps: 0 });
      return outcome;
    },
  };
}

class FakeProcess implements ProcessLike {
  readonly exitCalls: number[] = [];
  on(): unknown {
    return this;
  }
  off(): unknown {
    return this;
  }
  exit(code = 0): void {
    this.exitCalls.push(code);
  }
}

const capabilities = () =>
  detectCapabilities({
    env: { LANG: "en_US.UTF-8" },
    stdoutIsTTY: true,
    stdinIsTTY: true,
    columns: 100,
    rows: 40,
  });

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("exit epilogue + session resume", () => {
  it("prints the logo, usage table, and a resume command that restores the session", async () => {

    const services = createCompositionRoot({
      agent: scriptedAgent("the answer"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    const sessionId = services.session.sessionId;

    const written: string[] = [];
    const epilogue = createExitEpilogue({
      services,
      startedAt: Date.now() - 95_000,
      write: (text) => void written.push(text),
    });

    const destroyed: string[] = [];
    const handle: RendererHandle = {
      start: () => {},
      destroy: () => {
        destroyed.push("destroy");
        services.dispose();
      },
    };
    const lifecycle = new RendererLifecycle({
      handle,
      process: new FakeProcess(),
      disposers: [
        epilogue.capture,
        async () => {
          await services.session.persistNow().catch(() => undefined);
        },
      ],
      epilogue: epilogue.run,
    });
    await lifecycle.start();

    await services.session.submit("what is the plan?");
    expect(services.session.usageReport().totals.requests).toBe(1);

    await lifecycle.shutdownAndExit(0);

    expect(destroyed).toEqual(["destroy"]);
    expect(written).toHaveLength(1);
    const output = plain(written[0]!);
    expect(output).toContain("█");
    expect(output).toContain("nvidia / test-model");
    expect(output).toContain("1,200");
    expect(output).toContain("340");
    expect(output).toContain("1,540");
    expect(output).toContain("25.0%");
    expect(output).toContain("1m35s");
    expect(output).toContain(`clai --resume ${sessionId}`);

    vi.resetModules();
    const { createCompositionRoot: freshRoot } = await import(
      "../src/ui-core/bootstrap/composition-root.js"
    );
    const { resolveResumeTarget, applySessionResume } = await import(
      "../src/ui-core/bootstrap/session-resume.js"
    );

    const resolution = await resolveResumeTarget({ kind: "id", id: sessionId });
    expect(resolution.error).toBeUndefined();
    expect(resolution.record?.id).toBe(sessionId);

    const resumed = freshRoot({
      agent: scriptedAgent("second answer"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    const outcome = await applySessionResume(resumed, resolution.record!);

    expect(outcome.sessionId).toBe(sessionId);
    expect(resumed.session.sessionId).toBe(sessionId);
    expect(resumed.session.messages.map((m) => m.content)).toEqual([
      "what is the plan?",
      "the answer",
    ]);

    const restoredUsage = resumed.session.usageReport();
    expect(restoredUsage.totals.requests).toBe(1);
    expect(restoredUsage.totals.promptTokens).toBe(1200);
    expect(restoredUsage.totals.completionTokens).toBe(340);
    expect(restoredUsage.routes[0]).toMatchObject({
      provider: "nvidia",
      model: "test-model",
    });
    resumed.dispose();
  });

  it("resolves the newest session in this directory for --continue", async () => {
    const { resolveResumeTarget } = await import(
      "../src/ui-core/bootstrap/session-resume.js"
    );

    const first = createCompositionRoot({
      agent: scriptedAgent("first"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    await first.session.submit("first prompt");
    await first.session.persistNow();
    first.dispose();

    const second = createCompositionRoot({
      agent: scriptedAgent("second"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    await second.session.submit("second prompt");
    await second.session.persistNow();
    const newestId = second.session.sessionId;
    second.dispose();

    const resolution = await resolveResumeTarget({ kind: "latest" });
    expect(resolution.error).toBeUndefined();
    expect(resolution.record?.id).toBe(newestId);
  });

  it("resolves a unique session id prefix and rejects an unknown one", async () => {
    const { resolveResumeTarget } = await import(
      "../src/ui-core/bootstrap/session-resume.js"
    );

    const services = createCompositionRoot({
      agent: scriptedAgent("answer"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    await services.session.submit("a prompt");
    await services.session.persistNow();
    const sessionId = services.session.sessionId;
    services.dispose();

    const byPrefix = await resolveResumeTarget({
      kind: "id",
      id: sessionId.slice(0, sessionId.length - 3),
    });
    expect(byPrefix.record?.id).toBe(sessionId);

    const missing = await resolveResumeTarget({ kind: "id", id: "sess-nope" });
    expect(missing.record).toBeUndefined();
    expect(missing.error).toContain("no session matches");

    const blank = await resolveResumeTarget({ kind: "id", id: "   " });
    expect(blank.error).toBe("a session id is required");
  });

  it("offers no resume command when history is disabled", async () => {

    const services = createCompositionRoot({
      agent: scriptedAgent("private answer"),
      provider: "nvidia" as never,
      model: "test-model",
      noHistory: true,
      capabilities: capabilities(),
    });
    await services.session.submit("secret prompt");

    const written: string[] = [];
    createExitEpilogue({
      services,
      startedAt: Date.now(),
      write: (text) => void written.push(text),
    }).run();

    expect(plain(written[0]!)).toContain("cannot be resumed");
    expect(plain(written[0]!)).not.toContain("clai --resume");
    services.dispose();
  });

  it("captures the summary before teardown clears the session", async () => {

    const services = createCompositionRoot({
      agent: scriptedAgent("answer"),
      provider: "nvidia" as never,
      model: "test-model",
      capabilities: capabilities(),
    });
    await services.session.submit("a prompt");
    const sessionId = services.session.sessionId;

    const written: string[] = [];
    const epilogue = createExitEpilogue({
      services,
      startedAt: Date.now(),
      write: (text) => void written.push(text),
    });
    epilogue.capture();
    services.session.reset({ mintNewId: true });
    epilogue.run();

    expect(plain(written[0]!)).toContain(`clai --resume ${sessionId}`);
    expect(plain(written[0]!)).toContain("nvidia / test-model");
    services.dispose();
  });
});
