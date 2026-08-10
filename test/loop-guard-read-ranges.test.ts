import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { completedOperationSignature } from "../src/agent/outcomes.js";
import {
  dedupeToolContextOutput,
  getReliabilityPolicy,
} from "../src/agent/reliability-policy.js";

describe("loop guard fs.read range handling", () => {
  it("does not conflate different line ranges of the same file", () => {
    const guard = new LoopGuard();
    const first = guard.canonicalize("fs.read", { path: "a", offset: 1, limit: 120 });
    const second = guard.canonicalize("fs.read", { path: "a", offset: 440, limit: 100 });
    expect(first).not.toBe(second);

    const sigFirst = completedOperationSignature("fs.read", { path: "a", offset: 1, limit: 120 });
    const sigSecond = completedOperationSignature("fs.read", { path: "a", offset: 440, limit: 100 });
    expect(sigFirst).toBeDefined();
    expect(sigSecond).toBeDefined();
    expect(sigFirst).not.toBe(sigSecond);
  });

  it("canonicalizes fs.read alias spellings to the same signature", () => {
    const guard = new LoopGuard();
    expect(guard.canonicalize("fs.read", { path: "a", offset: 440, limit: 100 })).toBe(
      guard.canonicalize("fs.read", { path: "a", startLine: 440, limit: 100 }),
    );
    expect(guard.canonicalize("fs.read", { path: "a", offset: 0 })).toBe(
      guard.canonicalize("fs.read", { path: "a", offset: 1 }),
    );
    expect(guard.canonicalize("fs.read", { path: "a", startLine: 10, endLine: 29 })).toBe(
      guard.canonicalize("fs.read", { path: "a", offset: 10, limit: 20 }),
    );

    expect(completedOperationSignature("fs.read", { path: "a", offset: 440, limit: 100 })).toBe(
      completedOperationSignature("fs.read", { path: "a", startLine: 440, limit: 100 }),
    );
    expect(completedOperationSignature("fs.read", { path: "a", startLine: 10, endLine: 29 })).toBe(
      completedOperationSignature("fs.read", { path: "a", offset: 10, limit: 20 }),
    );
  });

  it("blocks an unchanged re-read even when the alias spelling changes", () => {
    const guard = new LoopGuard();
    for (let step = 1; step <= 3; step += 1) {
      guard.recordAttempt(step, "fs.read", { path: "a", offset: 440, limit: 100 }, true, 0, "same body");
    }
    expect(guard.shouldBlock("fs.read", { path: "a", startLine: 440, limit: 100 })).toMatchObject({ block: true });
    expect(guard.shouldBlock("fs.read", { path: "a", offset: 441, limit: 100 }).block).toBe(false);
  });

  it("dedupes tool output by content, never by file path", () => {
    const policy = { ...getReliabilityPolicy(), toolResultDedup: true };
    const seenHashes = new Map<string, { toolName: string; count: number }>();
    const bodyA = `A${"x".repeat(500)}`;
    const bodyB = `B${"y".repeat(500)}`;

    const firstA = dedupeToolContextOutput({ content: bodyA, toolName: "fs.read", seenHashes, policy });
    expect(firstA.deduped).toBe(false);
    const otherRange = dedupeToolContextOutput({ content: bodyB, toolName: "fs.read", seenHashes, policy });
    expect(otherRange.deduped).toBe(false);

    const repeatA = dedupeToolContextOutput({ content: bodyA, toolName: "fs.read", seenHashes, policy });
    expect(repeatA.deduped).toBe(true);
    expect(repeatA.content).toContain("duplicate tool output");
  });
});
