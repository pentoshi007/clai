import { describe, expect, it } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import { createPlan, loadPlan, mutatePlan, savePlan, type PlanStatus } from "../src/store/plan.js";
import type { ToolCall } from "../src/types.js";

async function seedPlan(sessionId: string, status: PlanStatus = "completed") {
  const plan = createPlan({
    sessionId,
    goal: "Polish editor layout",
    detail: "Keep editor shortcuts stable.",
    taskTitles: ["Fix editor spacing", "Verify editor alignment"],
    kind: "feature",
    meta: { packageManager: "npm" },
  });
  plan.status = status;
  if (status !== "draft") {
    Object.assign(plan.tasks[0]!, { state: "done", note: "Verified", evidence: { successWorkCount: 2, lastOkTool: "fs.read" } });
    Object.assign(plan.tasks[1]!, { state: status === "completed" ? "skipped" : "in_progress", note: "Existing task", aliases: ["editor_alignment"] });
  }
  await savePlan(plan);
  return (await loadPlan(sessionId))!;
}

function runPlanCall(sessionId: string, name: string, args: ToolCall["args"]) {
  return handlePlanTool({ name, args }, createSessionPolicy(sessionId), { loopGuard: new LoopGuard(), step: 1 });
}

describe("batch plan edits", () => {
  it("appends an ordered task batch as one version while preserving the current task", async () => {
    const before = await seedPlan("batch-add", "in_progress");
    const result = await runPlanCall(before.sessionId, "task.add", {
      tasks: ["Implement editor shortcuts", {
        title: "Verify shortcut behavior",
        parentTaskId: "implement_editor_shortcuts",
        dependencies: ["editor_alignment", "implement_editor_shortcuts"],
        resourceLocks: ["editor fixtures", "editor fixtures"],
        acceptanceCriteria: "Open and save work with the keyboard",
        note: "Use a fresh editor session",
      }],
    });
    expect(result.ok, result.modelNote).toBe(true);
    const after = (await loadPlan(before.sessionId))!;
    expect(after).toMatchObject({ goal: before.goal, detail: before.detail, version: before.version! + 1 });
    expect(after.tasks.slice(0, 2)).toEqual(before.tasks);
    expect(after.tasks.slice(2)).toMatchObject([
      { id: "t3", state: "pending", title: "Implement editor shortcuts" },
      { id: "t4", state: "pending", parentTaskId: "t3", dependencies: ["t2", "t3"], resourceLocks: ["editor fixtures"], acceptanceCriteria: "Open and save work with the keyboard", note: "Use a fresh editor session" },
    ]);
    expect(result.modelNote).toMatch(/\[t3\].*\[t4\]/);
  });

  it("renames and extends a completed plan in one edit alongside a responder settlement", async () => {
    const seed = await seedPlan("batch-extend-completed");
    await mutatePlan(seed.sessionId, draft => {
      draft.tasks.push({ id: "t3", title: "Check fixtures", state: "in_progress", dependencies: [], resourceLocks: [], responderOwned: true, jobId: "job-fixtures", parentTaskId: "t1" });
    });
    const before = (await loadPlan(seed.sessionId))!;
    const [result, settlement] = await Promise.all([
      runPlanCall(before.sessionId, "plan.update", {
        goal: "  Editor layout\n and shortcuts ",
        detail: "Keep editor shortcuts stable and cover keyboard navigation.",
        tasks: ["Add keyboard navigation", { title: "Exercise keyboard navigation", dependencies: ["add_keyboard_navigation"] }],
      }),
      mutatePlan(before.sessionId, draft => {
        draft.tasks[2]!.state = "done";
        draft.tasks[2]!.settledResultRevision = 4;
      }),
    ]);
    expect(result.ok, result.modelNote).toBe(true);
    expect(settlement.ok).toBe(true);
    const after = (await loadPlan(before.sessionId))!;
    expect(after).toMatchObject({
      goal: "Editor layout and shortcuts",
      detail: "Keep editor shortcuts stable and cover keyboard navigation.",
      sessionId: before.sessionId, createdAt: before.createdAt, kind: before.kind,
      meta: before.meta, status: "in_progress", version: before.version! + 2,
    });
    expect(after.tasks.slice(0, 3)).toEqual([
      ...before.tasks.slice(0, 2), { ...before.tasks[2], state: "done", settledResultRevision: 4 },
    ]);
    expect(after.tasks.slice(3)).toMatchObject([{ id: "t4", state: "pending" }, { id: "t5", state: "pending", dependencies: ["t4"] }]);
  });

  it.each(["draft", "completed"] as const)("retitles a %s plan without changing its state or tasks", async (status) => {
    const before = await seedPlan(`batch-rename-${status}`, status);
    const session = createSessionPolicy(before.sessionId);
    const result = await handlePlanTool({ name: "plan.update", args: { goal: "Editor polish" } }, session, { loopGuard: new LoopGuard(), step: 1 });
    expect(result.ok, result.modelNote).toBe(true);
    expect((await loadPlan(before.sessionId))).toEqual({
      ...before, goal: "Editor polish", version: before.version! + 1, updatedAt: expect.any(String),
    });
    expect(session.planApproved.value).toBe(false);
  });

  it.each([
    { name: "plan.update", args: { goal: "Editor layout and shortcuts", tasks: ["Valid first task", { title: "Broken task", dependencies: ["unknown"] }] }, reason: /unknown dependency/ },
    { name: "plan.update", args: { goal: "x".repeat(81), tasks: ["Valid first task"] }, reason: /80 characters/ },
    { name: "plan.update", args: {}, reason: /goal, detail or tasks/ },
    { name: "task.add", args: { tasks: [{ title: "Add navigation" }, "t999"] }, reason: /descriptive title/ },
    { name: "task.add", args: { tasks: [{ title: "Add navigation", dependencies: [13] }] }, reason: /dependencies/ },
    { name: "task.add", args: { tasks: [] }, reason: /non-empty/ },
    { name: "task.add", args: { tasks: ["Add navigation"], title: "Conflicting task" }, reason: /either/ },
  ])("rolls back an invalid $name batch ($reason)", async ({ name, args, reason }, index) => {
    const before = await seedPlan(`batch-invalid-${index}`);
    const result = await runPlanCall(before.sessionId, name, args);
    expect(result).toMatchObject({ ok: false, modelNote: expect.stringMatching(reason) });
    expect(await loadPlan(before.sessionId)).toEqual(before);
  });

  it("does not create a plan when plan.update has no target", async () => {
    const result = await runPlanCall("batch-no-plan", "plan.update", { goal: "Editor layout", tasks: ["Fix spacing"] });
    expect(result).toMatchObject({ ok: false, modelNote: expect.stringContaining("no active plan") });
    expect(await loadPlan("batch-no-plan")).toBeUndefined();
  });

  it("defers unfinished reports behind new work without moving work that needs the report", async () => {
    const plan = createPlan({
      sessionId: "batch-report-order", goal: "Editor changes", detail: "Ship the editor changes", kind: "feature",
      taskTitles: ["Verify the editor", "Write the report to docs/editor.md"],
    });
    plan.tasks[0]!.state = "done";
    plan.tasks[1]!.state = "in_progress";
    plan.status = "in_progress";
    await savePlan(plan);
    const result = await runPlanCall(plan.sessionId, "task.add", {
      tasks: [
        "Check editor keyboard navigation",
        { title: "Fix navigation focus", dependencies: ["check_editor_keyboard_navigation"] },
        { title: "Read the published instructions", dependencies: ["t2"] },
        { title: "Verify the release package", dependencies: ["read_the_published_instructions"] },
      ],
    });
    expect(result.ok, result.modelNote).toBe(true);
    expect(result.plan?.tasks.map(task => task.id)).toEqual(["t1", "t3", "t4", "t2", "t5", "t6"]);
    expect(result.plan?.tasks.find(task => task.id === "t2")).toMatchObject({ state: "pending", dependencies: ["t1", "t3", "t4"] });
  });
});

it("does not replace a completed plan if a follow-up still uses plan.create", async () => {
  const before = await seedPlan("legacy-follow-up");
  const result = await runPlanCall(before.sessionId, "plan.create", {
    goal: "Add editor keyboard shortcuts",
    detail: "Add shortcuts and verify them",
    tasks: [{ title: "Add keyboard shortcuts", acceptanceCriteria: "Save works by keystroke" }, "Verify shortcut behavior"],
    kind: "feature",
  });
  expect(result.ok, result.modelNote).toBe(true);
  expect(result.modelNote).toContain("plan.update");
  const after = (await loadPlan(before.sessionId))!;
  expect(after).toMatchObject({ status: "in_progress", goal: before.goal, createdAt: before.createdAt, version: before.version! + 1 });
  expect(after.tasks.slice(0, 2)).toEqual(before.tasks);
  expect(after.tasks.slice(2)).toMatchObject([
    { id: "t3", state: "pending", title: "Add keyboard shortcuts", acceptanceCriteria: "Save works by keystroke" },
    { id: "t4", state: "pending", title: "Verify shortcut behavior", dependencies: ["t3"] },
  ]);
});
