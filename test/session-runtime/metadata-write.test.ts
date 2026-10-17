import { randomUUID } from "node:crypto";
import { readFile, readdir, rename } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeDir, runtimeMetadataPath, runtimeSocketPath } from "../../src/session-runtime/paths.js";
import { readRuntimeMetadata, writeRuntimeMetadata } from "../../src/session-runtime/store.js";
import type { RuntimeMetadata } from "../../src/session-runtime/types.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(fs.rename) };
});
const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const originalPlatform = process.platform;

beforeEach(() => {
  vi.mocked(rename).mockReset().mockImplementation(fs.rename);
});
afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

function metadata(): RuntimeMetadata {
  const sessionId = `rename-${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    version: 1, sessionId, hostPid: process.pid, socketPath: runtimeSocketPath(sessionId), token: "a".repeat(64),
    cwd: process.cwd(), startedAt: now, updatedAt: now, phase: "running", busy: false, attached: false,
  };
}
function windows(): void {
  Object.defineProperty(process, "platform", { value: "win32" });
}
function denied(code: string): Error {
  return Object.assign(new Error("metadata replacement failed"), { code });
}

async function expectNoStagingFiles(): Promise<void> {
  expect((await readdir(getRuntimeDir())).filter((name) => name.endsWith(".tmp"))).toEqual([]);
}

describe("runtime metadata replacement", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("retries transient Windows %s without removing the previous metadata", async (code) => {
    windows();
    const previous = metadata();
    await writeRuntimeMetadata(previous);
    vi.mocked(rename).mockClear().mockImplementationOnce(async () => {
      expect(await readRuntimeMetadata(previous.sessionId)).toEqual(previous);
      throw denied(code);
    }).mockRejectedValueOnce(denied(code));
    const next = { ...previous, busy: true };
    await writeRuntimeMetadata(next);
    expect(rename).toHaveBeenCalledTimes(3);
    expect(await readRuntimeMetadata(previous.sessionId)).toEqual(next);
    await expectNoStagingFiles();
  });

  it("bounds persistent Windows sharing errors and preserves the original metadata", async () => {
    windows();
    const previous = metadata();
    await writeRuntimeMetadata(previous);
    const original = await readFile(runtimeMetadataPath(previous.sessionId), "utf8");
    vi.mocked(rename).mockClear().mockRejectedValue(denied("EPERM"));
    await expect(writeRuntimeMetadata({ ...previous, busy: true })).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(9);
    expect(await readFile(runtimeMetadataPath(previous.sessionId), "utf8")).toBe(original);
    await expectNoStagingFiles();
  });

  it("does not retry non-sharing failures on Windows", async () => {
    windows();
    vi.mocked(rename).mockRejectedValueOnce(denied("ENOSPC"));
    await expect(writeRuntimeMetadata(metadata())).rejects.toMatchObject({ code: "ENOSPC" });
    expect(rename).toHaveBeenCalledTimes(1);
    await expectNoStagingFiles();
  });

  it("leaves POSIX rename errors immediate instead of masking permission failures", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    vi.mocked(rename).mockRejectedValueOnce(denied("EPERM"));
    await expect(writeRuntimeMetadata(metadata())).rejects.toMatchObject({ code: "EPERM" });
    expect(rename).toHaveBeenCalledTimes(1);
    await expectNoStagingFiles();
  });
});
