import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(), readMetadata: vi.fn(), probe: vi.fn(), findLive: vi.fn(), findBun: vi.fn(), stat: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: mocks.spawn,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), stat: mocks.stat,
}));
vi.mock("../../src/session-runtime/store.js", () => ({ readRuntimeMetadata: mocks.readMetadata }));
vi.mock("../../src/session-runtime/discovery.js", () => ({ probeRuntime: mocks.probe, findLiveRuntime: mocks.findLive }));
vi.mock("../../src/os/bun-runtime.js", () => ({ isBunRuntime: () => false, findBunExecutable: mocks.findBun }));

import { startRuntimeHost } from "../../src/session-runtime/startup.js";
import { decodeRuntimeHostPayload, RUNTIME_HOST_ENV } from "../../src/session-runtime/launch.js";
import type { RuntimeMetadata } from "../../src/session-runtime/types.js";

const metadata: RuntimeMetadata = {
  version: 1, sessionId: "startup-fixture", hostPid: 42, socketPath: "fixture", token: "a".repeat(64),
  cwd: process.cwd(), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  phase: "running", busy: false, attached: false,
};
const options = { entryPath: "/clai/dist/index.js", childArgs: ["--classic"] };
let child: ChildProcess;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  child = Object.assign(new EventEmitter(), {
    pid: 42, exitCode: null, signalCode: null, killed: false,
    unref: vi.fn(), kill: vi.fn(), disconnect: vi.fn(), connected: true,
    channel: { unref: vi.fn() },
  }) as unknown as ChildProcess;
  mocks.spawn.mockReturnValue(child);
  mocks.probe.mockResolvedValue(true);
  mocks.findLive.mockResolvedValue(undefined);
  mocks.readMetadata.mockResolvedValue(undefined);
  mocks.stat.mockRejectedValue(new Error("ENOENT"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function start(): Promise<RuntimeMetadata | Error> {
  return startRuntimeHost(options, { sessionId: metadata.sessionId }).catch((error: Error) => error);
}

describe("runtime host startup", () => {
  it("allows a cold host to become ready after the former ten-second deadline", async () => {
    const began = Date.now();
    mocks.readMetadata.mockImplementation(async () => Date.now() - began >= 12_000 ? metadata : undefined);
    const pending = start();
    await vi.advanceTimersByTimeAsync(12_100);
    expect(await pending).toEqual(metadata);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("polls only the target metadata instead of rescanning unrelated runtimes", async () => {
    mocks.readMetadata.mockResolvedValueOnce(undefined).mockResolvedValue(metadata);
    const pending = start();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(metadata);
    expect(mocks.findLive).not.toHaveBeenCalled();
  });

  it("reports an exited broker immediately rather than waiting for the deadline", async () => {
    let result: RuntimeMetadata | Error | undefined;
    const pending = start().then((value) => { result = value; });
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(child, { exitCode: 7 });
    child.emit("exit", 7, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("exited with code 7");
    await pending;
  });

  it("preserves a broker's structured startup error", async () => {
    const pending = start();
    await vi.advanceTimersByTimeAsync(0);
    child.emit("message", { type: "runtime-startup-error", message: "runtime socket permission denied" });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await pending).toEqual(new Error("runtime socket permission denied"));
  });

  it("preserves spawn failures and terminates an unready host on timeout", async () => {
    const pending = start();
    await vi.advanceTimersByTimeAsync(0);
    child.emit("error", new Error("spawn EACCES"));
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual(new Error("spawn EACCES"));
    const timedOut = start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await timedOut as Error).message).toContain("did not become ready");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("accepts the ready metadata of a concurrent lease winner", async () => {
    mocks.readMetadata.mockResolvedValue({ ...metadata, hostPid: 99 });
    const pending = start();
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ ...metadata, hostPid: 99 });
  });

  it("waits for a concurrent winner whose lease precedes its metadata", async () => {
    const began = Date.now();
    mocks.stat.mockResolvedValue({});
    mocks.readMetadata.mockImplementation(async () => Date.now() - began >= 12_000 ? { ...metadata, hostPid: 99 } : undefined);
    const pending = start();
    await vi.advanceTimersByTimeAsync(0);
    Object.assign(child, { exitCode: 0 });
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(12_100);
    expect(await pending).toEqual({ ...metadata, hostPid: 99 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("does not switch an explicit Classic session to an unrelated Bun installation", async () => {
    mocks.findBun.mockReturnValue("/obsolete/bun");
    mocks.readMetadata.mockResolvedValue(metadata);
    expect(await start()).toEqual(metadata);
    expect(mocks.spawn.mock.calls[0]![0]).toBe(process.execPath);
    expect(mocks.findBun).not.toHaveBeenCalled();
  });

  it("retains independent pipe views and the requested child arguments", async () => {
    mocks.readMetadata.mockResolvedValue(metadata);
    expect(await start()).toEqual(metadata);
    const spawnOptions = mocks.spawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv; detached: boolean };
    const payload = decodeRuntimeHostPayload(spawnOptions.env[RUNTIME_HOST_ENV]);
    expect(payload).toMatchObject({ independentViews: true, sessionId: metadata.sessionId });
    expect(payload?.launch.args).toContain("--classic");
    expect(spawnOptions.detached).toBe(true);
    expect(child.disconnect).toHaveBeenCalledOnce();
  });
});
