import { afterEach, describe, expect, it } from "vitest";
import {
  clearAllPlans,
  createPlan,
  loadPlan,
  normalizeTaskDependencies,
  readyPlanTasks,
  savePlan,
} from "../src/store/plan.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";

describe("normalizeTaskDependencies", () => {
  afterEach(async () => {
    await clearAllPlans();
  });

  it("keeps acyclic forward edges and drops only broken ones", () => {
    const plan = createPlan({
      sessionId: "deps-forward",
      goal: "blog",
      detail: "frontend",
      kind: "coding",
      taskTitles: [
        "Scaffold project config",
        "Implement glassmorphic design system",
        "Implement core lib",
        "Implement contexts + Toast",
        "Implement UI components",
        "Implement pages",
        "Wire App + entry",
        "Install dependencies",
        "Typecheck + production build",
        "Run dev server + probe",
      ],
    });
    // Simulate remapped ids with a broken forward edge (real bug seen in UI).
    plan.tasks[0]!.id = "t1";
    plan.tasks[1]!.id = "t10";
    plan.tasks[2]!.id = "t2";
    plan.tasks[3]!.id = "t3";
    plan.tasks[4]!.id = "t4";
    plan.tasks[5]!.id = "t5";
    plan.tasks[6]!.id = "t6";
    plan.tasks[7]!.id = "t7";
    plan.tasks[8]!.id = "t8";
    plan.tasks[9]!.id = "t9";
    plan.tasks[0]!.dependencies = [];
    plan.tasks[1]!.dependencies = ["t1"];
    plan.tasks[2]!.dependencies = ["t9"]; // broken: core depends on final task
    plan.tasks[3]!.dependencies = ["t10"];
    plan.tasks[4]!.dependencies = ["t2"];
    plan.tasks[5]!.dependencies = ["t3"];
    plan.tasks[6]!.dependencies = ["t4"];
    plan.tasks[7]!.dependencies = ["t5"];
    plan.tasks[8]!.dependencies = ["t6"];
    plan.tasks[9]!.dependencies = ["t7"];

    // List position carries no scheduling meaning: an acyclic edge to a later
    // row is a legitimate DAG edge and is preserved.
    expect(normalizeTaskDependencies(plan.tasks)).toBe(false);
    expect(plan.tasks[2]!.dependencies).toEqual(["t9"]);

    // Self, unknown and cycle-closing edges are the only ones removed.
    plan.tasks[2]!.dependencies = ["t9", "t2", "missing"];
    plan.tasks[9]!.dependencies = ["t7"];
    expect(normalizeTaskDependencies(plan.tasks)).toBe(true);
    expect(plan.tasks[2]!.dependencies).toEqual(["t9"]);

    plan.tasks[1]!.dependencies = ["t1", "t2"];
    expect(normalizeTaskDependencies(plan.tasks)).toBe(true);
    expect(plan.tasks[1]!.dependencies).toEqual(["t1"]);

    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "done";
    expect(readyPlanTasks(plan).map((task) => task.id)).not.toContain("t2");
  });

  it("keeps an explicitly empty dependency list and defaults only legacy rows", () => {
    const plan = createPlan({
      sessionId: "deps-explicit",
      goal: "app",
      detail: "d",
      kind: "coding",
      taskTitles: ["one", "two", "three"],
    });
    plan.tasks[1]!.dependencies = [];
    plan.tasks[2]!.dependencies = [];
    expect(normalizeTaskDependencies(plan.tasks)).toBe(false);
    expect(plan.tasks[1]!.dependencies).toEqual([]);
    expect(plan.tasks[2]!.dependencies).toEqual([]);
  });

  it("preserves authored dependencies while opening early without a warning", async () => {
    const session = createSessionPolicy("heal-dag");
    session.planApproved.value = true;
    const plan = createPlan({
      sessionId: "heal-dag",
      goal: "app",
      detail: "d",
      kind: "coding",
      taskTitles: ["one", "two", "three"],
    });
    plan.status = "in_progress";
    plan.tasks[0]!.state = "done";
    // Break two so it depends on three (forward)
    plan.tasks[1]!.dependencies = ["t3"];
    plan.tasks[2]!.dependencies = ["t1"];
    await savePlan(plan);

    const result = await handlePlanTool(
      {
        name: "task.update",
        args: { taskId: "t2", state: "in_progress" },
      },
      session,
      { loopGuard: new LoopGuard(), step: 1 },
    );
    expect(result.ok).toBe(true);
    expect(result.modelNote).not.toMatch(/WARNING/);
    expect(result.toast).toBeUndefined();
    const live = await loadPlan("heal-dag");
    expect(live!.tasks.find((t) => t.id === "t2")?.state).toBe("in_progress");
    expect(live!.tasks.find((t) => t.id === "t2")?.dependencies).toContain(
      "t3",
    );
  });
});
