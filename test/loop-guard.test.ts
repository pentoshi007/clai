import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";

describe("LoopGuard", () => {
  it("does not block the first call", () => {
    const guard = new LoopGuard();
    const result = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(result.block).toBe(false);
    expect(result.reason).toBe(undefined);
  });

  it("warns on the first repeat", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, true);
    const result = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(result.block).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("blocks on the second repeat (third call)", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, true);
    guard.recordAttempt(1, "shell.exec", { command: "whoami" }, true);
    const result = guard.shouldBlock("shell.exec", { command: "whoami" });
    expect(result.block).toBe(true);
    expect(result.reason).toContain("2 time(s)");
  });

  it("treats whitespace-normalized commands as equivalent", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "  ls   -la  " }, true);
    guard.recordAttempt(1, "shell.exec", { command: "ls -la" }, true);
    const result = guard.shouldBlock("shell.exec", { command: "ls  -la" });
    expect(result.block).toBe(true);
  });

  it("does not confuse different arguments", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "whoami" }, true);
    guard.recordAttempt(1, "shell.exec", { command: "whoami" }, true);
    const result = guard.shouldBlock("shell.exec", { command: "hostname" });
    expect(result.block).toBe(false);
  });

  it("tracks attempt count correctly", () => {
    const guard = new LoopGuard();
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(0);
    guard.recordAttempt(0, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(1);
    guard.recordAttempt(1, "shell.exec", { command: "ls" }, true);
    expect(guard.getAttemptCount("shell.exec", { command: "ls" })).toBe(2);
  });

  it("detects repeated failures", () => {
    const guard = new LoopGuard();
    guard.recordAttempt(0, "shell.exec", { command: "foo" }, false);
    guard.recordAttempt(1, "shell.exec", { command: "bar" }, false);
    guard.recordAttempt(2, "shell.exec", { command: "baz" }, false);
    expect(guard.hasRepeatedFailures(3)).toBe(true);
    expect(guard.hasRepeatedFailures(4)).toBe(false);
  });

  it("sorts args keys for consistent canonicalization", () => {
    const guard = new LoopGuard();
    const sig1 = guard.canonicalize("test", { b: 2, a: 1 });
    const sig2 = guard.canonicalize("test", { a: 1, b: 2 });
    expect(sig1).toBe(sig2);
  });
});
