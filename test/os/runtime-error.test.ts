import { describe, expect, it } from "vitest";
import { formatRuntimeError, runtimeErrorCode } from "../../src/os/runtime-error.js";

describe("runtime failure diagnostics", () => {
  it.each([
    ["EDQUOT", "Storage quota exceeded", "TMPDIR"],
    ["ENOSPC", "Storage is full", "inodes"],
    ["EACCES", "Permission denied", "Check access"],
    ["EPERM", "Operation not permitted", "Check permissions"],
    ["EMFILE", "Too many open files", "open-file limit"],
    ["ENFILE", "system open-file limit", "Close unused processes"],
    ["ENOMEM", "Not enough memory", "concurrent work"],
  ])("explains %s and gives a recovery step", (code, problem, recovery) => {
    const error = Object.assign(new Error("unknown error, write"), { code });
    const message = formatRuntimeError(error);
    expect(runtimeErrorCode(error)).toBe(code);
    expect(message).toContain(problem);
    expect(message).toContain(code);
    expect(message).toContain(recovery);
  });

  it("finds filesystem failures inside wrapped errors", () => {
    const cause = Object.assign(new Error("write failed"), { code: "EDQUOT" });
    expect(formatRuntimeError(new Error("could not save", { cause }))).toContain("Storage quota exceeded");
  });

  it("preserves detailed recovery instructions from wrapped permission errors", () => {
    const cause = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const error = new Error("Restore ownership of /data/clai to your current user.", { cause });
    const message = formatRuntimeError(error);
    expect(message).toContain("Permission denied (EACCES)");
    expect(message).toContain("Restore ownership of /data/clai to your current user.");
  });

  it("recognizes string rejections and messages without an error code property", () => {
    expect(formatRuntimeError("EDQUOT: unknown error, write")).toContain("Storage quota exceeded");
    expect(formatRuntimeError(new Error("ENOSPC: no space left on device"))).toContain("Storage is full");
  });

  it("does not loop on cyclic causes", () => {
    const error = new Error("unknown failure");
    error.cause = error;
    expect(runtimeErrorCode(error)).toBeUndefined();
    expect(formatRuntimeError(error)).toBe("unknown failure");
  });

  it("sanitizes and bounds unexpected errors", () => {
    const message = formatRuntimeError(new Error(`\x1b[31mfailed\x1b[0m ${"x".repeat(2_000)}`));
    expect(message).not.toContain("\x1b");
    expect(message).toContain("failed");
    expect(message.length).toBeLessThanOrEqual(1_000);
  });
});
