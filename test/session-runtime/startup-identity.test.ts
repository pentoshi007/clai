import { describe, expect, it, vi } from "vitest";

const identity = vi.hoisted(() => ({
  capture: vi.fn(() => "fixture-identity"),
  captureAsync: vi.fn(async () => "fixture-identity"),
  compare: vi.fn(() => "match"),
  compareAsync: vi.fn(async () => "match"),
  forget: vi.fn(),
}));
vi.mock("../../src/os/process-identity.js", () => ({ processIdentityTracker: identity }));

import { SessionRuntimeHost } from "../../src/session-runtime/host.js";
import { readRuntimeMetadata } from "../../src/session-runtime/store.js";
import { probeRuntime } from "../../src/session-runtime/discovery.js";

it("keeps process identity subprocesses off the runtime startup and probe event loop", async () => {
  const sessionId = `async-identity-${Date.now()}`;
  const running = new SessionRuntimeHost({
    version: 1, sessionId, cwd: process.cwd(), independentViews: true,
    launch: { file: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 1400)"] },
    columns: 100, rows: 30, idleTimeoutMs: 60_000,
  }).run();
  try {
    await expect.poll(async () => {
      const metadata = await readRuntimeMetadata(sessionId);
      return metadata?.phase === "running" && await probeRuntime(metadata);
    }, { timeout: 5_000 }).toBe(true);
    await running;
    expect(identity.capture).not.toHaveBeenCalled();
    expect(identity.compare).not.toHaveBeenCalled();
    expect(identity.captureAsync).toHaveBeenCalled();
    expect(identity.compareAsync).toHaveBeenCalled();
  } finally {
    await running;
  }
}, 10_000);
