import { chmod, stat, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { listLiveRuntimeMetadata } from "../../src/session-runtime/discovery.js";
import { runtimeLockPath, runtimeSocketPath } from "../../src/session-runtime/paths.js";
import {
  createRuntimeToken,
  listRuntimeMetadata,
  readRuntimeMetadata,
  reapStaleRuntimeLock,
  tryAcquireRuntimeLease,
  writeRuntimeMetadata,
} from "../../src/session-runtime/store.js";
import { RUNTIME_PROTOCOL_VERSION } from "../../src/session-runtime/types.js";

describe("session runtime store", () => {
  it("writes and reads user-only metadata atomically", async () => {
    const sessionId = `metadata-${Date.now()}`;
    const now = new Date().toISOString();
    await writeRuntimeMetadata({
      version: RUNTIME_PROTOCOL_VERSION,
      sessionId,
      hostPid: process.pid,
      socketPath: runtimeSocketPath(sessionId),
      token: createRuntimeToken(),
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
      phase: "running",
      busy: true,
      attached: false,
    });
    expect((await readRuntimeMetadata(sessionId))?.sessionId).toBe(sessionId);
    expect((await listRuntimeMetadata()).some((entry) => entry.sessionId === sessionId)).toBe(true);
    if (process.platform !== "win32") {
      const metadata = await import("../../src/session-runtime/paths.js");
      const mode = (await stat(metadata.runtimeMetadataPath(sessionId))).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("holds one exclusive lease and releases it for the next host", async () => {
    const sessionId = `lease-${Date.now()}`;
    const first = await tryAcquireRuntimeLease(sessionId);
    expect(first).toBeDefined();
    expect(await tryAcquireRuntimeLease(sessionId)).toBeUndefined();
    await first?.release();
    const second = await tryAcquireRuntimeLease(sessionId);
    expect(second).toBeDefined();
    await second?.release();
  });

  it("reaps stale metadata whose recorded host identity is gone", async () => {
    const sessionId = `stale-metadata-${Date.now()}`;
    const now = new Date().toISOString();
    await writeRuntimeMetadata({
      version: RUNTIME_PROTOCOL_VERSION,
      sessionId,
      hostPid: 2_147_483_647,
      hostIdentity: "dead-host",
      socketPath: runtimeSocketPath(sessionId),
      token: createRuntimeToken(),
      cwd: process.cwd(),
      startedAt: now,
      updatedAt: now,
      phase: "running",
      busy: false,
      attached: false,
    });
    expect(await readRuntimeMetadata(sessionId)).toBeDefined();
    const live = await listLiveRuntimeMetadata();
    expect(live.some((entry) => entry.sessionId === sessionId)).toBe(false);
    expect(await readRuntimeMetadata(sessionId)).toBeUndefined();
  });

  it("reclaims a lock only when its recorded owner is gone", async () => {
    const sessionId = `stale-${Date.now()}`;
    const path = runtimeLockPath(sessionId);
    await writeFile(
      path,
      `${JSON.stringify({ pid: 2_147_483_647, identity: "dead", createdAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    await chmod(path, 0o600).catch(() => undefined);
    expect(await reapStaleRuntimeLock(sessionId)).toBe(true);
    const lease = await tryAcquireRuntimeLease(sessionId);
    expect(lease).toBeDefined();
    await lease?.release();
  });
});
