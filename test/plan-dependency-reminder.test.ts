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
    taskTitles: ["Scaffold", "Install deps", "Run and verify"],
  });
  plan.status = "in_progress";
  await savePlan(plan);
  return plan;
}

function openTask(sessionId: string, taskId: string) {
  return { name: "task.update", args: { taskId, state: "in_progress" } } as const;
}

describe("dependency-open reminder", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("opens an early task immediately and allows out-of-order completion", async () => {
    const sessionId = "dep-remind";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const opened = await handlePlanTool(openTask(sessionId, "t2"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(opened.ok).toBe(true);
    expect(opened.reminder).toBeUndefined();
    expect(opened.toast).toBeUndefined();
    const live = await loadPlan(sessionId);
    expect(live!.tasks.find((task) => task.id === "t2")?.state).toBe("in_progress");

    const completed = await handlePlanTool(
      { name: "task.update", args: { taskId: "t2", state: "done" } },
      session,
      { loopGuard: new LoopGuard(), step: 2 },
    );
    expect(completed.ok).toBe(true);
  });

  it("opens a dependency-ready task normally without any reminder", async () => {
    const sessionId = "dep-ready";
    const session = createSessionPolicy(sessionId);
    session.planApproved.value = true;
    await seedPlan(sessionId);

    const result = await handlePlanTool(openTask(sessionId, "t1"), session, {
      loopGuard: new LoopGuard(),
      step: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.reminder).toBeUndefined();
    const live = await loadPlan(sessionId);
    expect(live!.tasks.find((t) => t.id === "t1")?.state).toBe("in_progress");
  });
});
