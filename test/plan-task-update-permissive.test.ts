import { afterEach, describe, expect, it } from "vitest";
import { clearAllPlans, createPlan, loadPlan, savePlan } from "../src/store/plan.js";
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
  await savePlan(plan);
  return plan;
}

function update(taskId: string, state: string) {
  return { name: "task.update", args: { taskId, state } } as const;
}

const REJECTION_COPY =
  /REJECTED|will not apply|still in_progress|must be in_progress|no successful tool result|not complete|not reopened|one active task only/i;

describe("task.update applies batched and out-of-order transitions", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("opens several tasks at once without single-active rejection", async () => {
    const sessionId = "batch-open";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    for (const [index, taskId] of ["t1", "t2", "t3"].entries()) {
      const result = await handlePlanTool(update(taskId, "in_progress"), session, {
        loopGuard: new LoopGuard(),
        step: index + 1,
      });
      expect(result.ok).toBe(true);
      expect(result.display).not.toMatch(REJECTION_COPY);
      expect(result.modelNote).not.toMatch(REJECTION_COPY);
    }

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.map((task) => task.state)).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
    ]);
  });

  it("completes tasks out of dependency order with no evidence gate", async () => {
    const sessionId = "out-of-order-done";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const third = await handlePlanTool(update("t3", "done"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(third.ok).toBe(true);
    expect(third.display).not.toMatch(REJECTION_COPY);
    expect(third.modelNote).not.toMatch(REJECTION_COPY);

    const second = await handlePlanTool(update("t2", "done"), session, {
      loopGuard: new LoopGuard(),
      step: 2,
    });
    expect(second.ok).toBe(true);

    const first = await handlePlanTool(update("t1", "done"), session, {
      loopGuard: new LoopGuard(),
      step: 3,
    });
    expect(first.ok).toBe(true);

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.map((task) => task.state)).toEqual(["done", "done", "done"]);
    expect(live.status).toBe("completed");
  });

  it("marks done straight from pending and allows rewind", async () => {
    const sessionId = "direct-done-rewind";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const done = await handlePlanTool(update("t2", "done"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(done.ok).toBe(true);

    const rewind = await handlePlanTool(update("t2", "pending"), session, {
      loopGuard: new LoopGuard(),
      step: 2,
    });
    expect(rewind.ok).toBe(true);

    const live = (await loadPlan(sessionId))!;
    expect(live.tasks.find((task) => task.id === "t2")!.state).toBe("pending");
  });
});
