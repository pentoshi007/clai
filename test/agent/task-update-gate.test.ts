import { describe, expect, it } from "vitest";
import type { SessionPlan, SessionTask } from "../../src/store/plan.js";
import {
  decideTaskUpdateDoneGate,
  parseTaskUpdateRequest,
} from "../../src/agent/turn/task-update-gate.js";

const task = (overrides: Partial<SessionTask>): SessionTask =>
  ({
    id: "t1",
    title: "task",
    state: "pending",
    ...overrides,
  }) as SessionTask;

const plan = (tasks: SessionTask[]): SessionPlan =>
  ({
    sessionId: "s1",
    goal: "goal",
    kind: "build",
    tasks,
  }) as SessionPlan;

const allow = (): { ok: true } => ({ ok: true });

describe("task update gate", () => {
  it("reads taskId then id and defaults to empty strings", () => {
    expect(parseTaskUpdateRequest({ state: "done", taskId: "a" })).toEqual({
      state: "done",
      taskId: "a",
    });
    expect(parseTaskUpdateRequest({ id: "b" })).toEqual({
      state: "",
      taskId: "b",
    });
    expect(parseTaskUpdateRequest({ taskId: 1, id: 2 })).toEqual({
      state: "",
      taskId: "",
    });
  });

  it("blocks when the active plan is unavailable", () => {
    expect(decideTaskUpdateDoneGate(undefined, "t1", allow)).toEqual({
      ok: false,
      reason:
        "Task t1 cannot be marked done because its active plan is unavailable.",
    });
  });

  it("delegates in_progress tasks to the completion gate", () => {
    let seen = "";
    const result = decideTaskUpdateDoneGate(
      plan([task({ state: "in_progress" })]),
      "t1",
      (_plan, id) => {
        seen = id;
        return { ok: false, reason: "needs evidence" };
      },
    );
    expect(seen).toBe("t1");
    expect(result).toEqual({ ok: false, reason: "needs evidence" });
  });

  it("soft-completes a pending task whose dependencies are satisfied", () => {
    const result = decideTaskUpdateDoneGate(
      plan([
        task({ id: "t0", state: "done" }),
        task({ id: "t1", state: "pending", dependencies: ["t0"] }),
      ]),
      "t1",
      allow,
    );
    expect(result).toEqual({ ok: true });
  });

  it("refuses a pending task with unsatisfied dependencies", () => {
    const result = decideTaskUpdateDoneGate(
      plan([
        task({ id: "t0", state: "in_progress" }),
        task({ id: "t1", state: "pending", dependencies: ["t0"] }),
      ]),
      "t1",
      allow,
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "Task t1 must be in_progress before it can be marked done. Start or retry the task, perform fresh work, then complete it.",
    });
  });

  it("treats a missing dependency as incomplete", () => {
    const result = decideTaskUpdateDoneGate(
      plan([task({ id: "t1", state: "pending", dependencies: ["ghost"] })]),
      "t1",
      allow,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts skipped dependencies", () => {
    const result = decideTaskUpdateDoneGate(
      plan([
        task({ id: "t0", state: "skipped" }),
        task({ id: "t1", state: "pending", dependencies: ["t0"] }),
      ]),
      "t1",
      allow,
    );
    expect(result).toEqual({ ok: true });
  });

  it("gives failed tasks their own recovery message", () => {
    const result = decideTaskUpdateDoneGate(
      plan([task({ state: "failed" })]),
      "t1",
      allow,
    );
    expect(result).toEqual({
      ok: false,
      reason:
        "Task t1 is failed — retry with in_progress first, then mark done after recovery work.",
    });
  });

  it("refuses an unknown task id", () => {
    const result = decideTaskUpdateDoneGate(plan([]), "t9", allow);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      reason: expect.stringContaining("must be in_progress"),
    });
  });
});
