import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMetadata } from "../../src/session-runtime/types.js";

const mocks = vi.hoisted(() => ({
  listLiveRuntimeMetadata: vi.fn(),
  readRuntimeMetadata: vi.fn(),
  compare: vi.fn(),
  processAlive: vi.fn(),
}));

vi.mock("../../src/session-runtime/discovery.js", () => ({
  listLiveRuntimeMetadata: mocks.listLiveRuntimeMetadata,
}));

vi.mock("../../src/session-runtime/store.js", () => ({
  readRuntimeMetadata: mocks.readRuntimeMetadata,
}));

vi.mock("../../src/os/process-identity.js", () => ({
  processIdentityTracker: { compare: mocks.compare },
}));

vi.mock("../../src/os/process-tree.js", () => ({
  processAlive: mocks.processAlive,
}));

import { enforceIdleRuntimeCap } from "../../src/session-runtime/reaper.js";
import { RUNTIME_PROTOCOL_VERSION } from "../../src/session-runtime/types.js";

function runtime(
  sessionId: string,
  hostPid: number,
  updatedAt: string,
  overrides: Partial<RuntimeMetadata> = {},
): RuntimeMetadata {
  return {
    version: RUNTIME_PROTOCOL_VERSION,
    sessionId,
    hostPid,
    hostIdentity: `identity-${hostPid}`,
    socketPath: `/tmp/${sessionId}.sock`,
    token: "a".repeat(64),
    cwd: "/tmp",
    startedAt: updatedAt,
    updatedAt,
    phase: "running",
    busy: false,
    active: false,
    attached: false,
    ...overrides,
  };
}

describe("idle runtime cap enforcement", () => {
  const originalCap = process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;

  beforeEach(() => {
    process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = "1";
    mocks.listLiveRuntimeMetadata.mockReset();
    mocks.readRuntimeMetadata.mockReset();
    mocks.compare.mockReset().mockReturnValue("match");
    mocks.processAlive.mockReset().mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCap === undefined) {
      delete process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;
    } else {
      process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = originalCap;
    }
  });

  it("SIGTERMs the oldest revalidated idle runtime but protects active queued work", async () => {
    const queued = runtime("queued", 4101, "2026-01-01T00:00:00.000Z", {
      busy: true,
      active: true,
    });
    const oldestIdle = runtime("old-idle", 4102, "2026-01-02T00:00:00.000Z");
    const newestIdle = runtime("new-idle", 4103, "2026-01-03T00:00:00.000Z");
    const bySession = new Map(
      [queued, oldestIdle, newestIdle].map((metadata) => [
        metadata.sessionId,
        metadata,
      ]),
    );
    mocks.listLiveRuntimeMetadata.mockResolvedValue([
      queued,
      oldestIdle,
      newestIdle,
    ]);
    mocks.readRuntimeMetadata.mockImplementation(async (sessionId: string) =>
      bySession.get(sessionId),
    );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    await expect(enforceIdleRuntimeCap()).resolves.toBe(1);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(oldestIdle.hostPid, "SIGTERM");
  });

  it("does not signal a victim that became attached before the revalidation read", async () => {
    const oldestIdle = runtime("old-idle", 4201, "2026-01-01T00:00:00.000Z");
    const newestIdle = runtime("new-idle", 4202, "2026-01-02T00:00:00.000Z");
    mocks.listLiveRuntimeMetadata.mockResolvedValue([oldestIdle, newestIdle]);
    mocks.readRuntimeMetadata.mockResolvedValue({
      ...oldestIdle,
      attached: true,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);

    await expect(enforceIdleRuntimeCap()).resolves.toBe(0);
    expect(kill).not.toHaveBeenCalled();
  });
});
