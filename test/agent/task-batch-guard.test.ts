import { describe, expect, it } from "vitest";
import type { SessionPlan, SessionTask } from "../../src/store/plan.js";
import type { ToolCall } from "../../src/types.js";
import { batchUpdateSignature } from "../../src/agent/task-sync.js";
import { evaluateTaskBatchGuard } from "../../src/agent/turn/task-batch-guard.js";

const call = (args: Record<string, unknown>): ToolCall => ({
  name: "task.update",
  args,
});

const task = (id: string, state: SessionTask["state"]): SessionTask =>
  ({ id, title: `title ${id}`, state }) as SessionTask;

const plan = (tasks: SessionTask[]): SessionPlan =>
  ({ sessionId: "s1", goal: "g", kind: "build", tasks }) as SessionPlan;

describe("task batch guard", () => {
  it("clears any pending signature when nothing advances", () => {
    const outcome = evaluateTaskBatchGuard({
      calls: [{ name: "fs.read", args: { path: "a" } }],
      plan: plan([]),
      pendingSignature: "stale",
    });
    expect(outcome.reminderNote).toBe("");
    expect(outcome.pendingSignature).toBeUndefined();
    expect(outcome.notices).toEqual([]);
    expect(outcome.remindCalls.size).toBe(0);
  });

  it("rejects opening more than one task and never becomes confirmable", () => {
    const first = call({ taskId: "t1", state: "in_progress" });
    const second = call({ taskId: "t2", state: "in_progress" });
    const outcome = evaluateTaskBatchGuard({
      calls: [first, second],
      plan: plan([task("t1", "pending"), task("t2", "pending")]),
      pendingSignature: undefined,
    });
    expect(outcome.pendingSignature).toBeUndefined();
    expect(outcome.remindCalls.has(first)).toBe(true);
    expect(outcome.remindCalls.has(second)).toBe(true);
    expect(outcome.reminderNote.length).toBeGreaterThan(0);
    expect(outcome.notices).toHaveLength(1);
    expect(outcome.notices[0]!.level).toBe("warn");
  });

  it("holds a simultaneous advance behind one reminder signature", () => {
    const first = call({ taskId: "t1", state: "done" });
    const second = call({ taskId: "t2", state: "done" });
    const outcome = evaluateTaskBatchGuard({
      calls: [first, second],
      plan: plan([task("t1", "in_progress"), task("t2", "in_progress")]),
      pendingSignature: undefined,
    });
    expect(outcome.pendingSignature).toBeDefined();
    expect(outcome.remindCalls.size).toBe(2);
    expect(outcome.reminderNote.length).toBeGreaterThan(0);
    expect(outcome.notices[0]!.level).toBe("warn");
  });

  it("applies the identical re-issued batch and clears the signature", () => {
    const first = call({ taskId: "t1", state: "done" });
    const second = call({ taskId: "t2", state: "done" });
    const livePlan = plan([task("t1", "in_progress"), task("t2", "in_progress")]);
    const held = evaluateTaskBatchGuard({
      calls: [first, second],
      plan: livePlan,
      pendingSignature: undefined,
    });
    const confirmed = evaluateTaskBatchGuard({
      calls: [first, second],
      plan: livePlan,
      pendingSignature: held.pendingSignature,
    });
    expect(confirmed.pendingSignature).toBeUndefined();
    expect(confirmed.remindCalls.size).toBe(0);
    expect(confirmed.reminderNote).toBe("");
    expect(confirmed.notices).toEqual([
      { level: "info", message: "confirmed batch task update — applying" },
    ]);
  });

  it("signs the batch from plan-resolved task ids", () => {
    const livePlan = plan([task("t1", "in_progress"), task("t2", "in_progress")]);
    const calls = [
      call({ taskId: "t1", state: "done" }),
      call({ taskId: "t2", state: "done" }),
    ];
    const outcome = evaluateTaskBatchGuard({
      calls,
      plan: livePlan,
      pendingSignature: undefined,
    });
    expect(outcome.pendingSignature).toBe(
      batchUpdateSignature([
        { call: calls[0]!, taskId: "t1", state: "done" },
        { call: calls[1]!, taskId: "t2", state: "done" },
      ]),
    );
  });

  it("falls back to the raw task id when no plan is loaded", () => {
    const outcome = evaluateTaskBatchGuard({
      calls: [
        call({ taskId: "t1", state: "done" }),
        call({ taskId: "t2", state: "done" }),
      ],
      plan: undefined,
      pendingSignature: undefined,
    });
    expect(outcome.pendingSignature).toContain("t1");
    expect(outcome.pendingSignature).toContain("t2");
  });
});
