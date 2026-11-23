import { afterEach, describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import {
  createPlan,
  deletePlan,
  loadPlan,
  savePlan,
} from "../src/store/plan.js";
import type { ToolCall } from "../src/types.js";

const sessions: string[] = [];

async function seed(sessionId: string, titles: string[]) {
  sessions.push(sessionId);
  const plan = createPlan({
    sessionId,
    goal: "complete assessment",
    detail: "work then report",
    kind: "pentest",
    taskTitles: titles,
  });
  plan.status = "in_progress";
  await savePlan(plan);
  const policy = createSessionPolicy(sessionId);
  policy.planApproved.value = true;
  return { plan, policy };
}

async function invoke(
  sessionId: string,
  call: ToolCall,
) {
  const policy = createSessionPolicy(sessionId);
  policy.planApproved.value = true;
  return handlePlanTool(call, policy, {
    loopGuard: new LoopGuard(),
    step: 1,
  });
}

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((sessionId) => deletePlan(sessionId)));
});

describe("task.move handler", () => {
  it.each([
    {
      label: "one-based position",
      args: { taskId: "t3", position: 1 },
      expected: ["t3", "t1", "t2", "t4"],
    },
    {
      label: "before anchor",
      args: { taskId: "t4", beforeTaskId: "t2" },
      expected: ["t1", "t4", "t2", "t3"],
    },
    {
      label: "after anchor",
      args: { taskId: "t1", afterTaskId: "t3" },
      expected: ["t2", "t3", "t1", "t4"],
    },
  ])("supports $label", async ({ args, expected }, index) => {
    const sessionId = `move-handler-${index}`;
    const { plan } = await seed(sessionId, ["one", "two", "three", "four"]);
    plan.tasks[2]!.state = "in_progress";
    plan.tasks[2]!.note = "keep me";
    plan.tasks[2]!.evidence = {
      successWorkCount: 2,
      lastOkTool: "fs.read",
      lastOkAt: "2026-01-01T00:00:00.000Z",
    };
    await savePlan(plan);

    const result = await invoke(sessionId, { name: "task.move", args });
    expect(result.ok).toBe(true);
    const live = await loadPlan(sessionId);
    expect(live?.tasks.map((task) => task.id)).toEqual(expected);
    const moved = live?.tasks.find((task) => task.id === args.taskId);
    if (args.taskId === "t3") {
      expect(moved).toMatchObject({
        state: "in_progress",
        note: "keep me",
        evidence: { successWorkCount: 2, lastOkTool: "fs.read" },
      });
    }
  });

  it("rejects multiple destination selectors without changing the plan", async () => {
    const sessionId = "move-handler-invalid";
    await seed(sessionId, ["one", "two", "three"]);

    const result = await invoke(sessionId, {
      name: "task.move",
      args: { taskId: "t2", position: 1, beforeTaskId: "t1" },
    });

    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(/exactly one/i);
    expect((await loadPlan(sessionId))?.tasks.map((task) => task.id)).toEqual([
      "t1",
      "t2",
      "t3",
    ]);
  });
});

describe("task.add report handling", () => {
  it("places discovered work before an unfinished report file task", async () => {
    const sessionId = "report-defer-open";
    const { plan } = await seed(sessionId, [
      "Check the application settings",
      "Write the assessment report to docs/assessment.md",
    ]);
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "in_progress";
    await savePlan(plan);

    const result = await invoke(sessionId, {
      name: "task.add",
      args: { title: "Verify the new settings shortcut" },
    });

    expect(result.ok).toBe(true);
    const live = await loadPlan(sessionId);
    expect(live?.tasks.map((task) => task.id)).toEqual(["t1", "t3", "t2"]);
    expect(live?.tasks[2]).toMatchObject({
      state: "pending",
      dependencies: ["t1", "t3"],
    });
    expect(result.modelNote).toMatch(/report.*deferred/i);
  });

  it.each(["build", "pentest"])("adds only the requested work across %s follow-ups", async (kind) => {
    const sessionId = `report-defer-done-${kind}`;
    const originalTitles = ["Check the application settings", "Compile final report"];
    const { plan } = await seed(sessionId, originalTitles);
    plan.kind = kind;
    for (const task of plan.tasks) task.state = "done";
    plan.status = "completed";
    await savePlan(plan);

    const followUps = ["Verify the new settings shortcut", "Fix the popover click handling"];
    for (const [index, title] of followUps.entries()) {
      const added = await invoke(sessionId, { name: "task.add", args: { title } });
      expect(added.ok).toBe(true);
      expect(added.plan?.status).toBe("in_progress");
      expect((await loadPlan(sessionId))?.tasks.map((task) => task.title)).toEqual([
        ...originalTitles,
        ...followUps.slice(0, index + 1),
      ]);
      expect(added.plan?.tasks.slice(0, 2)).toEqual(plan.tasks);

      const completed = await invoke(sessionId, {
        name: "task.update",
        args: { taskId: `t${index + 3}`, state: "done" },
      });
      expect(completed.plan?.status).toBe("completed");
      expect(completed.modelNote).toContain("give your final summary");
    }
  });

  it("tracks an explicit update to a completed report file", async () => {
    const sessionId = "report-file-update";
    const { plan } = await seed(sessionId, ["Write the report to docs/assessment.md"]);
    plan.tasks[0]!.state = "done";
    plan.status = "completed";
    await savePlan(plan);

    const args = {
      title: "Update final report with the new settings findings",
      acceptanceCriteria: "docs/assessment.md includes the verified keyboard behavior",
      dependencies: ["t1"],
    };
    const result = await invoke(sessionId, { name: "task.add", args });

    expect(result.ok).toBe(true);
    expect((await loadPlan(sessionId))?.tasks).toMatchObject([
      { id: "t1", state: "done" },
      { id: "t2", state: "pending", ...args },
    ]);
  });
});
