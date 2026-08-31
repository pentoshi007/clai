import { describe, expect, it } from "vitest";
import {
  evaluateLoopGuardBlock,
  evaluateToolGuards,
  readRetryReason,
} from "../../src/agent/turn/tool-execution/guards.js";

const guard = (overrides: Record<string, unknown> = {}) =>
  evaluateToolGuards({
    call: { name: "net.scan", args: { target: "lab" } },
    narrowNmapOperation: false,
    narrowNmapDispatched: 0,
    heldBatchReminder: undefined,
    ...overrides,
  } as never);

describe("tool guards", () => {
  it("proceeds when no guard applies", () => {
    expect(guard()).toEqual({ kind: "proceed", consumesNarrowNmapScan: false });
  });

  it("rejects unrelated tools during a narrow nmap request", () => {
    const decision = guard({
      call: { name: "dns.lookup", args: {} },
      narrowNmapOperation: true,
    });
    expect(decision.kind).toBe("reject");
    expect(decision).toMatchObject({
      reason: expect.stringContaining("Narrow nmap request: dns.lookup"),
    });
  });

  it("allows the single scan and marks it as consuming the budget", () => {
    expect(guard({ narrowNmapOperation: true })).toEqual({
      kind: "proceed",
      consumesNarrowNmapScan: true,
    });
  });

  it("rejects a second scan in the same narrow turn", () => {
    const decision = guard({
      narrowNmapOperation: true,
      narrowNmapDispatched: 1,
    });
    expect(decision).toMatchObject({
      kind: "reject",
      reason: expect.stringContaining("already been dispatched"),
    });
  });

  it("allows read-only status tools during a narrow nmap request", () => {
    expect(
      guard({ call: { name: "shell.jobs", args: {} }, narrowNmapOperation: true }),
    ).toEqual({ kind: "proceed", consumesNarrowNmapScan: false });
  });

  it("holds a batch-reminded task update", () => {
    expect(
      guard({
        call: { name: "task.update", args: {} },
        heldBatchReminder: "confirm the batch",
      }),
    ).toEqual({ kind: "hold", reason: "confirm the batch" });
  });

  it("holds the batch even during a narrow nmap turn", () => {
    expect(
      guard({
        call: { name: "task.read", args: {} },
        narrowNmapOperation: true,
        heldBatchReminder: "confirm the batch",
      }),
    ).toEqual({ kind: "hold", reason: "confirm the batch" });
  });

  it("reads a structured retry reason and ignores anything else", () => {
    expect(readRetryReason({ _retryReason: { code: "E", detail: "d" } })).toEqual(
      { code: "E", detail: "d" },
    );
    expect(readRetryReason({ _retryReason: {} })).toEqual({
      code: "",
      detail: "",
    });
    expect(readRetryReason({ _retryReason: "nope" })).toBeUndefined();
    expect(readRetryReason({})).toBeUndefined();
  });
});

describe("loop guard block", () => {
  const call = { name: "shell.exec", args: { command: "ls" } };

  it("proceeds when the guard does not block", () => {
    expect(
      evaluateLoopGuardBlock(call, {
        verdict: { block: false },
        priorObservation: undefined,
      }),
    ).toEqual({ kind: "proceed", consumesNarrowNmapScan: false });
  });

  it("reuses a prior successful observation instead of re-running", () => {
    const decision = evaluateLoopGuardBlock(call, {
      verdict: { block: true, kind: "unchanged-success", reason: "no change" },
      priorObservation: "total 0",
    });
    expect(decision.kind).toBe("reuse");
    expect(decision).toMatchObject({
      reason: "no change\n\nPrior successful result (reuse this; it is the result of the requested call):\ntotal 0",
    });
  });

  it("reuses without an observation when none was recorded", () => {
    const decision = evaluateLoopGuardBlock(call, {
      verdict: { block: true, kind: "unchanged-success", reason: "no change" },
      priorObservation: undefined,
    });
    expect(decision).toEqual({ kind: "reuse", reason: "no change" });
  });

  it("warns and rejects a repeated failure", () => {
    const decision = evaluateLoopGuardBlock(call, {
      verdict: { block: true, kind: "repeat-failure" },
      priorObservation: undefined,
    });
    expect(decision).toEqual({
      kind: "warn-reject",
      reason:
        "shell.exec previously failed with identical arguments. Change the command/args and retry.",
    });
  });
});
