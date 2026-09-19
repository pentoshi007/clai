import { afterEach, describe, expect, it } from "vitest";
import { clearAllPlans, createPlan, loadPlan, markTask, savePlan } from "../src/store/plan.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";

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

describe("task.update allows concurrent foreground tasks", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("allows opening a second foreground task while one is active", async () => {
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
    expect(second.ok).toBe(true);

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t1")!.state).toBe("in_progress");
    expect(live.tasks.find((task) => task.id === "t2")!.state).toBe("in_progress");
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

describe("task transitions allow rewind and retry", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("allows rewinding a completed task through task.update", async () => {
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
    expect(rewind.ok).toBe(true);
    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t1")!.state).toBe("pending");
  });

  it("markTask allows rewinding a completed task", async () => {
    const plan = createPlan({
      sessionId: "mark-guard",
      goal: "g",
      detail: "d",
      taskTitles: ["only"],
    });
    plan.tasks[0]!.state = "done";
    expect(markTask(plan, plan.tasks[0]!.id, "pending")).toBe(true);
    expect(plan.tasks[0]!.state).toBe("pending");
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