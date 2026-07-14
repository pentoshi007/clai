import { describe, expect, it, beforeEach } from "vitest";
import {
  createPlan,
  savePlan,
  loadPlan,
  markTask,
  markNextTask,
  isPlanComplete,
  planProgress,
  clearAllPlans,
  tasksFromTitles,
} from "../src/store/plan.js";

// CLAI_PLAN_FILE is set by the vitest env? We rely on VITEST_WORKER_ID which
// routes the store to a temp JSONL file, so these tests never touch the real
// ~/.clai/history.db.

describe("plan store", () => {
  beforeEach(async () => {
    await clearAllPlans();
  });

  it("creates a plan with numbered task ids", () => {
    const plan = createPlan({
      sessionId: "s1",
      goal: "build blog",
      detail: "Vite + React because modern",
      taskTitles: ["scaffold", "install", "verify"],
      kind: "coding",
    });
    expect(plan.tasks.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
    expect(plan.tasks.every((t) => t.state === "pending")).toBe(true);
    expect(plan.status).toBe("draft");
  });

  it("persists and reloads a plan by session id", async () => {
    const plan = createPlan({
      sessionId: "s2",
      goal: "recon",
      detail: "whois then dns",
      taskTitles: ["whois", "dns"],
      kind: "pentest",
    });
    await savePlan(plan);
    const loaded = await loadPlan("s2");
    expect(loaded?.goal).toBe("recon");
    expect(loaded?.kind).toBe("pentest");
    expect(loaded?.tasks).toHaveLength(2);
  });

  it("keeps plans session-scoped", async () => {
    await savePlan(createPlan({ sessionId: "a", goal: "A", detail: "", taskTitles: ["x"] }));
    await savePlan(createPlan({ sessionId: "b", goal: "B", detail: "", taskTitles: ["y"] }));
    expect((await loadPlan("a"))?.goal).toBe("A");
    expect((await loadPlan("b"))?.goal).toBe("B");
  });

  it("marks tasks and tracks progress + completion", () => {
    const plan = createPlan({
      sessionId: "s3",
      goal: "g",
      detail: "",
      taskTitles: ["one", "two"],
    });
    expect(markTask(plan, "t1", "done")).toBe(true);
    expect(planProgress(plan)).toEqual({ done: 1, total: 2 });
    expect(isPlanComplete(plan)).toBe(false);
    expect(markTask(plan, "t2", "done")).toBe(true);
    expect(isPlanComplete(plan)).toBe(true);
  });

  it("markNextTask advances through unfinished tasks", () => {
    const plan = createPlan({
      sessionId: "s4",
      goal: "g",
      detail: "",
      taskTitles: ["one", "two"],
    });
    expect(markNextTask(plan, "in_progress")?.id).toBe("t1");
    markTask(plan, "t1", "done");
    expect(markNextTask(plan, "in_progress")?.id).toBe("t2");
  });

  it("rejects unknown task ids", () => {
    const plan = createPlan({ sessionId: "s5", goal: "g", detail: "", taskTitles: ["one"] });
    expect(markTask(plan, "t99", "done")).toBe(false);
  });

  it("tasksFromTitles trims and drops empties", () => {
    expect(tasksFromTitles(["  a ", "", "b"]).map((t) => t.title)).toEqual(["a", "b"]);
  });

  it("merges existing task states into new plan tasks on plan.create", async () => {
    const { handlePlanTool } = await import("../src/agent/plan-tool.js");
    
    const plan1 = createPlan({
      sessionId: "s_merge",
      goal: "original goal",
      detail: "original detail",
      taskTitles: ["Task One", "Task Two", "Task Three"],
    });
    plan1.tasks[0]!.state = "done";
    plan1.tasks[1]!.state = "failed";
    plan1.tasks[1]!.note = "some error";
    await savePlan(plan1);

    const mockSession = { sessionId: "s_merge", planApproved: { value: false } };
    const result = await handlePlanTool(
      {
        id: "call1",
        name: "plan.create",
        args: {
          goal: "updated goal",
          detail: "updated detail",
          tasks: ["Task One", "Task Two", "Task Three", "Task Four"],
        },
      },
      mockSession as any,
      { loopGuard: {} as any, step: 1 }
    );

    expect(result.ok).toBe(true);
    const loaded = await loadPlan("s_merge");
    expect(loaded).toBeDefined();
    expect(loaded!.goal).toBe("updated goal");
    expect(loaded!.detail).toBe("updated detail");
    expect(loaded!.tasks).toHaveLength(4);
    
    expect(loaded!.tasks[0]!.title).toBe("Task One");
    expect(loaded!.tasks[0]!.state).toBe("done");

    expect(loaded!.tasks[1]!.title).toBe("Task Two");
    expect(loaded!.tasks[1]!.state).toBe("failed");
    expect(loaded!.tasks[1]!.note).toBe("some error");

    expect(loaded!.tasks[2]!.title).toBe("Task Three");
    expect(loaded!.tasks[2]!.state).toBe("pending");

    expect(loaded!.tasks[3]!.title).toBe("Task Four");
    expect(loaded!.tasks[3]!.state).toBe("pending");
  });
});
