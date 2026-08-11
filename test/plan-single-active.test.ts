import { afterEach, describe, expect, it } from "vitest";
import { clearAllPlans, createPlan, loadPlan, markTask, savePlan } from "../src/store/plan.js";
import {
  evaluateTaskTransition,
  isTerminalTaskState,
} from "../src/store/task-transitions.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import {
  buildMultiOpenRejection,
  multiOpenToast,
  openingTaskIds,
} from "../src/agent/task-sync.js";

async function seedPlan(sessionId: string) {
  const plan = createPlan({
    sessionId,
    goal: "app",
    detail: "d",
    kind: "coding",
    taskTitles: ["First", "Second", "Third"],
  });
  plan.status = "in_progress";
  for (const task of plan.tasks) task.dependencies = [];
  await savePlan(plan);
  return plan;
}

function openTask(sessionId: string, taskId: string) {
  return { name: "task.update", args: { taskId, state: "in_progress" } } as const;
}

describe("task.update single-active rejection (TASK-002)", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("refuses to open a second foreground task while one is active", async () => {
    const sessionId = "single-active";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const first = await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(first.ok).toBe(true);

    const second = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 2,
    });
    expect(second.ok).toBe(false);
    expect(second.modelNote).toMatch(/still in_progress/);

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t1")!.state).toBe("in_progress");
    expect(live.tasks.find((task) => task.id === "t2")!.state).toBe("pending");
  });

  it("allows the close-then-open handoff", async () => {
    const sessionId = "handoff";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    const closed = await handlePlanTool(
      { name: "task.update", args: { taskId: "t1", state: "done" } },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );
    expect(closed.ok).toBe(true);
    const opened = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 3,
    });
    expect(opened.ok).toBe(true);
    const live = (await loadPlan(sessionId))!;
    expect(
      live.tasks.filter((task) => task.state === "in_progress").map((t) => t.id),
    ).toEqual(["t2"]);
  });

  it("allows the defer-then-open handoff", async () => {
    const sessionId = "defer-handoff";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    const deferred = await handlePlanTool(
      { name: "task.update", args: { taskId: "t1", state: "pending" } },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );
    expect(deferred.ok).toBe(true);

    const opened = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 3,
    });
    expect(opened.ok).toBe(true);

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t1")!.state).toBe("pending");
    expect(
      live.tasks.filter((task) => task.state === "in_progress").map((task) => task.id),
    ).toEqual(["t2"]);
  });

  it("re-opening the already active task is not treated as a conflict", async () => {
    const sessionId = "reopen-self";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);
    await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    const again = await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 2,
    });
    expect(again.ok).toBe(true);
  });
});

describe("multi-open rejection copy", () => {
  const intent = (taskId: string, state: string) => ({
    call: { name: "task.update", args: { taskId, state } },
    taskId,
    state,
  });

  it("reports distinct opened ids only", () => {
    expect(
      openingTaskIds([
        intent("t1", "in_progress"),
        intent("t1", "in_progress"),
        intent("t2", "in_progress"),
        intent("t3", "done"),
      ] as any),
    ).toEqual(["t1", "t2"]);
  });

  it("states that the rejection is not confirmable", () => {
    const note = buildMultiOpenRejection([
      { taskId: "t1", title: "First", targetState: "in_progress" },
      { taskId: "t2", title: "Second", targetState: "in_progress" },
    ]);
    expect(note).toMatch(/REJECTED/);
    expect(note).toMatch(/will not apply/);
    expect(multiOpenToast(2)).toMatch(/one active task only/);
  });
});


describe("task transition table (TASK-003)", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("treats done and skipped as terminal", () => {
    expect(evaluateTaskTransition("done", "pending")).toMatchObject({
      allowed: false,
      code: "terminal",
    });
    expect(evaluateTaskTransition("done", "in_progress").allowed).toBe(false);
    expect(evaluateTaskTransition("skipped", "in_progress").allowed).toBe(false);
    expect(evaluateTaskTransition("done", "done").allowed).toBe(true);
    expect(isTerminalTaskState("failed")).toBe(false);
  });

  it("requires an explicit retry before a failed task can complete", () => {
    expect(evaluateTaskTransition("failed", "done")).toMatchObject({
      allowed: false,
      code: "retry-required",
    });
    expect(evaluateTaskTransition("failed", "in_progress").allowed).toBe(true);
  });

  it("rejects rewinding a completed task through task.update", async () => {
    const sessionId = "no-rewind";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);
    await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    await handlePlanTool(
      { name: "task.update", args: { taskId: "t1", state: "done" } },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );

    const rewind = await handlePlanTool(
      { name: "task.update", args: { taskId: "t1", state: "pending" } },
      session,
      { loopGuard: new LoopGuard(), step: 3 },
    );
    expect(rewind.ok).toBe(false);
    expect(rewind.modelNote).toMatch(/not reopened/);
    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t1")!.state).toBe("done");
  });

  it("markTask refuses a forbidden transition", async () => {
    const plan = createPlan({
      sessionId: "mark-guard",
      goal: "g",
      detail: "d",
      taskTitles: ["only"],
    });
    plan.tasks[0]!.state = "done";
    expect(markTask(plan, plan.tasks[0]!.id, "pending")).toBe(false);
    expect(plan.tasks[0]!.state).toBe("done");
  });
});

describe("plan.clear", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("removes a settled plan and resets approval", async () => {
    const sessionId = "clear-plan";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const result = await handlePlanTool(
      { name: "plan.clear", args: {} },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );

    expect(result).toMatchObject({ ok: true, cleared: true });
    expect(session.planApproved.value).toBe(false);
    expect(await loadPlan(sessionId)).toBeUndefined();
  });

  it("keeps a plan while responder-owned work is active", async () => {
    const sessionId = "clear-active-responder";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    const plan = await seedPlan(sessionId);
    plan.tasks[0]!.state = "in_progress";
    plan.tasks[0]!.responderOwned = true;
    plan.tasks[0]!.jobId = "job-clear";
    await savePlan(plan);

    const result = await handlePlanTool(
      { name: "plan.clear", args: {} },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );

    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/responder-owned and active/);
    expect(session.planApproved.value).toBe(true);
    expect((await loadPlan(sessionId))?.tasks[0]?.state).toBe("in_progress");
  });
});