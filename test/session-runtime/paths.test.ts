import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureRuntimeDirectories,
  getRuntimeSocketRoot,
  isRuntimeSocketPath,
  runtimeSocketPath,
} from "../../src/session-runtime/paths.js";

describe("session runtime paths", () => {
  it("keeps POSIX socket paths below the conservative macOS byte limit", async () => {
    await ensureRuntimeDirectories();
    const path = runtimeSocketPath(`socket-length-${Date.now()}`);
    expect(isRuntimeSocketPath(path)).toBe(true);
    if (process.platform === "win32") {
      expect(path).toMatch(/^\\\\\.\\pipe\\clai-runtime-[a-f0-9]{32}$/i);
      return;
    }
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(96);
    expect(basename(path)).toMatch(/^[a-f0-9]{24}\.sock$/i);
  });

  it("rejects lookalike socket names outside the private runtime roots", () => {
    const name = process.platform === "win32"
      ? "not-a-runtime-pipe"
      : join("/tmp", `${"a".repeat(24)}.sock`);
    expect(isRuntimeSocketPath(name)).toBe(false);
    if (process.platform !== "win32") {
      expect(
        isRuntimeSocketPath(join(getRuntimeSocketRoot(), "not-a-runtime.sock")),
      ).toBe(false);
    }
  });
});
