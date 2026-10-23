import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OmnirushCliSessionUploader } from "../../src/llm/omnirush-session-upload.js";
import { settleWithin } from "../../src/os/settle-within.js";
import { createOpenTuiRendererHandle } from "../../src/tui-v2/bootstrap/renderer-handle.js";
import { shutdownServices } from "../../src/ui-core/bootstrap/shutdown-services.js";

const never = <T>() => new Promise<T>(() => undefined);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function services(overrides: { session?: () => Promise<void>; mcp?: () => Promise<void>; terminals?: () => Promise<unknown>; upload?: () => Promise<void> }) {
  const order: string[] = [];
  const value = {
    overlay: { cancelBlockingPrompt: () => order.push("cancel") },
    cancel: { cancelAll: async () => { order.push("cancelWork"); return { ok: true }; } },
    session: { shutdown: async () => { order.push("session"); await (overrides.session?.() ?? Promise.resolve()); order.push("saved"); } },
    mcp: { closeAll: () => { order.push("mcp"); return overrides.mcp?.() ?? Promise.resolve(); } },
    ports: { interactiveSessions: { closeAll: () => { order.push("terminals"); return (overrides.terminals?.() ?? Promise.resolve({ owners: 0, closed: 0, failures: [] })); } } },
    omnirushSessionUpload: { close: () => { order.push("upload"); return overrides.upload?.() ?? Promise.resolve(); } },
  };
  return { order, services: value as never };
}

describe("bounded exit", () => {
  it("reports whether work settled inside the budget", async () => {
    expect(await settleWithin(Promise.resolve(1), 50)).toBe(true);
    expect(await settleWithin(Promise.reject(new Error("x")), 50)).toBe(true);
    expect(await settleWithin(never(), 10)).toBe(false);
  });

  it("always finishes the history save but stops waiting for stuck MCP servers, terminals and uploads", async () => {
    const save = Promise.withResolvers<void>();
    const { order, services: fake } = services({ session: () => save.promise, mcp: never, terminals: never, upload: never });
    let done = false;
    const shutdown = shutdownServices(fake, 40).then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(done).toBe(false);
    expect(order).toEqual(["cancel", "cancelWork", "mcp", "terminals", "session"]);
    save.resolve();
    const started = Date.now();
    await shutdown;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(order).toEqual(["cancel", "cancelWork", "mcp", "terminals", "session", "saved", "upload"]);
  });

  it("rethrows a failed history save after bounded cleanup", async () => {
    const { order, services: fake } = services({ session: () => Promise.reject(new Error("disk full")), mcp: never });
    await expect(shutdownServices(fake, 20)).rejects.toThrow("disk full");
    expect(order.at(-1)).toBe("upload");
  });

  it("does not let a renderer that never goes idle or finalizes block teardown", async () => {
    const calls: string[] = [];
    const { handle, done } = createOpenTuiRendererHandle({
      mount: () => calls.push("mount"),
      unmount: () => calls.push("unmount"),
      renderer: { pause: () => calls.push("pause"), suspend: () => calls.push("suspend"), idle: never, destroy: () => calls.push("destroy") },
      finalized: never(),
      disarmTerminalRescue: () => calls.push("disarm"),
      disposeServices: () => calls.push("dispose"),
      teardownBudgetMs: 20,
    });
    await handle.destroy();
    await done;
    expect(calls).toEqual(["unmount", "pause", "suspend", "destroy", "disarm", "dispose"]);
  });

  it("hands the session-end upload to a detached process instead of waiting for it", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "clai-omnirush-detach-"));
    dirs.push(workspaceDir);
    const calls: { args: readonly string[]; detached: boolean | undefined }[] = [];
    const uploader = new OmnirushCliSessionUploader({
      sessionId: "detach", workspaceDir,
      runner: async (_command, args, options) => {
        calls.push({ args, detached: options.detached });
        return { exitCode: 0 };
      },
    });
    await uploader.recordTurn("succeeded");
    await uploader.close();
    expect(calls.map((call) => call.detached)).toEqual([undefined, true]);
  });

  it("starts a real detached session-end upload without waiting for it to finish and reports a missing CLI", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "clai-omnirush-real-"));
    dirs.push(workspaceDir);
    const reports: string[] = [];
    const started = new OmnirushCliSessionUploader({ sessionId: "real", workspaceDir, command: process.execPath, report: (message) => reports.push(message) });
    await started.recordTurn("succeeded");
    const before = Date.now();
    await started.close();
    expect(Date.now() - before).toBeLessThan(5_000);
    const missing = new OmnirushCliSessionUploader({ sessionId: "missing", workspaceDir, command: join(workspaceDir, "no-such-omnirush"), report: (message) => reports.push(message) });
    await missing.recordTurn("succeeded");
    await missing.close();
    expect(reports).toContain("OmniRush session upload is unavailable because the OmniRush CLI was not found");
  });
});
