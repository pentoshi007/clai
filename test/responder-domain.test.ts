import { describe, expect, it } from "vitest";
import {
  appendPlanTask,
  createPlan,
  enforcePlanInvariants,
  foregroundActiveTask,
  foregroundRemaining,
  responderOpenTasks,
} from "../src/store/plan.js";
import {
  activeTaskId,
  taskOwnerChip,
  taskRowColor,
} from "../src/ui-core/rendering/plan-view.js";

function planWithChild() {
  const plan = createPlan({
    sessionId: "responder-domain",
    goal: "assess",
    detail: "d",
    kind: "pentest",
    taskTitles: ["Enumerate", "Report"],
  });
  plan.tasks[0]!.state = "done";
  appendPlanTask(plan, {
    title: "Responder · ffuf",
    state: "in_progress",
    dependencies: [],
    resourceLocks: [],
    parentTaskId: plan.tasks[0]!.id,
    jobId: "job-1",
    responderOwned: true,
  });
  return plan;
}

describe("foreground selectors", () => {
  it("excludes responder children from remaining and active work", () => {
    const plan = planWithChild();
    expect(foregroundRemaining(plan).map((task) => task.title)).toEqual([
      "Report",
    ]);
    expect(foregroundActiveTask(plan)?.title).toBe("Report");
    expect(responderOpenTasks(plan)).toHaveLength(1);
  });

  it("keeps the plan pane highlight on foreground work", () => {
    const plan = planWithChild();
    const child = plan.tasks.find((task) => task.responderOwned)!;
    expect(activeTaskId(plan)).not.toBe(child.id);
    expect(taskRowColor(child)).toBe("cyan");
    expect(taskOwnerChip(child)).toBe("RESPONDER · RUNNING");
    expect(taskOwnerChip(plan.tasks[0]!)).toBeUndefined();
  });
});

describe("orphan parent repair", () => {
  it("detaches a child whose parent a revision removed", () => {
    const plan = planWithChild();
    const parentId = plan.tasks[0]!.id;
    plan.tasks = plan.tasks.filter((task) => task.id !== parentId);
    const repairs = enforcePlanInvariants(plan);
    const child = plan.tasks.find((task) => task.responderOwned)!;
    expect(child.parentTaskId).toBeUndefined();
    expect(child.note).toContain(parentId);
    expect(repairs.join(" ")).toContain("detached");
  });
});
