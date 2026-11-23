import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopGuard } from "../src/agent/loop-guard.js";
import { handlePlanTool } from "../src/agent/plan-tool.js";
import type { TaskUpdateWork } from "../src/agent/plan/actions/task-update.js";
import { createSessionPolicy } from "../src/agent/session-policy.js";
import { creditSuccessfulWork } from "../src/agent/turn/task-credit.js";
import { runMetaTool, type MetaToolPorts } from "../src/agent/turn/tool-execution/meta-tools.js";
import * as planStore from "../src/store/plan.js";
import { appendPlanTask, clearAllPlans, createPlan, loadPlan, mutatePlan, savePlan } from "../src/store/plan.js";
import type { SessionPlan } from "../src/store/plan.js";
import type { ToolCall } from "../src/types.js";

const sessionId = "batch-task-update";
const ctx = { loopGuard: new LoopGuard(), step: 1 };
const close = { taskIds: ["t1", " checks "], state: "done", note: "verified" };
const open = { taskIds: ["t3"], state: "in_progress" };

async function seedPlan() {
  const plan = createPlan({ sessionId, goal: "Ship change", detail: "", taskTitles: [
    "Implement change", "Run checks", "Verify results", "Update documentation",
  ] });
  plan.status = "in_progress";
  Object.assign(plan.tasks[0]!, { state: "in_progress", note: "started", evidence: { successWorkCount: 2 } });
  plan.tasks[1]!.aliases = ["Checks", "Shared"];
  plan.tasks[2]!.aliases = ["shared"];
  plan.tasks[2]!.note = "keep this note";
  appendPlanTask(plan, {
    title: "Build in background",
    state: "in_progress",
    parentTaskId: "t1",
    responderOwned: true,
    jobId: "job-1",
    dependencies: [],
    resourceLocks: [],
  });
  await savePlan(plan);
  return (await loadPlan(sessionId))!;
}

function update(args: ToolCall["args"]) {
  return handlePlanTool({ name: "task.update", args }, createSessionPolicy(sessionId), ctx);
}

const byId = (plan: SessionPlan, id: string) => plan.tasks.find((task) => task.id === id)!;

afterEach(async () => {
  vi.restoreAllMocks();
  await clearAllPlans();
});

describe("atomic task.update", () => {
  it.each([false, true])("commits the handoff once (open listed first: %s)", async (openFirst) => {
    const before = await seedPlan();
    const result = await update({ updates: openFirst ? [open, close] : [close, open] });
    expect(result.ok).toBe(true);
    const plan = (await loadPlan(sessionId))!;
    expect(result.plan).toEqual(plan);
    expect(plan.version).toBe(before.version! + 1);
    expect(plan.status).toBe("in_progress");
    expect(byId(plan, "t1")).toMatchObject({ state: "done", note: "verified", evidence: { successWorkCount: 2 } });
    expect(byId(plan, "t2")).toMatchObject({ state: "done", note: "verified" });
    expect(byId(plan, "t3")).toMatchObject({ state: "in_progress", note: "keep this note" });
    expect(byId(plan, "t4")).toEqual(byId(before, "t4"));
    const child = before.tasks.find((task) => task.responderOwned)!;
    expect(byId(plan, child.id)).toEqual(child);
  });

  const invalid: [string, ToolCall["args"], RegExp][] = [
    ["empty batch", { updates: [] }, /updates.*non-empty/i],
    ["non-array batch", { updates: {} }, /updates.*non-empty/i],
    ["mixed forms", { updates: [close], taskId: "t3", state: "done" }, /either.*not both/i],
    ["malformed group", { updates: [close, null] }, /updates\[1\]/i],
    ["missing ids", { updates: [close, { state: "skipped" }] }, /taskIds/i],
    ["blank id", { updates: [close, { state: "skipped", taskIds: [" "] }] }, /taskIds/i],
    ["invalid state", { updates: [close, { ...open, state: "running" }] }, /state.*in_progress/i],
    ["invalid note", { updates: [close, { ...open, note: 5 }] }, /note.*string/i],
    ["unknown id", { updates: [close, { ...open, taskIds: ["t99"] }] }, /unknown taskId/i],
    ["ambiguous alias", { updates: [close, { ...open, taskIds: ["SHARED"] }] }, /ambiguous.*SHARED/i],
    ["duplicate alias", { updates: [close, { ...open, taskIds: ["t2"] }] }, /duplicate.*t2/i],
    ["duplicate id in group", { updates: [{ ...close, taskIds: ["t1", "t1"] }] }, /duplicate.*t1/i],
  ];
  it.each(invalid)("rejects %s without changing plan state or version", async (_label, args, error) => {
    const before = await seedPlan();
    const result = await update(args);
    expect(result.ok).toBe(false);
    expect(result.modelNote).toMatch(error);
    expect(await loadPlan(sessionId)).toEqual(before);
  });

  it("rejects the whole batch if a Responder child is targeted", async () => {
    const before = await seedPlan();
    const child = before.tasks.find((task) => task.responderOwned)!;
    const result = await update({ updates: [close, { ...open, taskIds: [child.id] }] });
    expect(result.ok).toBe(false);
    expect(result.modelNote).toContain("Responder-owned");
    expect(await loadPlan(sessionId)).toEqual(before);
  });

  it("preserves unrelated writes and Responder settlement during a batch", async () => {
    const before = await seedPlan();
    const child = before.tasks.find((task) => task.responderOwned)!;
    const [other, batch] = await Promise.all([
      mutatePlan(sessionId, (draft) => {
        Object.assign(byId(draft, "t4"), { state: "skipped", note: "not needed" });
        Object.assign(byId(draft, child.id), { state: "done", settledResultRevision: 2 });
      }),
      update({ updates: [close, open] }),
    ]);
    expect(other.ok).toBe(true);
    expect(batch.ok).toBe(true);
    const plan = (await loadPlan(sessionId))!;
    expect(plan.version).toBe(before.version! + 2);
    expect(byId(plan, "t3").state).toBe("in_progress");
    expect(byId(plan, "t4")).toMatchObject({ state: "skipped", note: "not needed" });
    expect(byId(plan, child.id)).toMatchObject({ state: "done", settledResultRevision: 2, responderOwned: true });
  });

  it("derives terminal status from all changes and reopens with legacy single calls", async () => {
    await seedPlan();
    const settled = await update({ updates: [
      close,
      { taskIds: ["t3"], state: "skipped", note: "optional" },
      { taskIds: ["t4"], state: "failed", note: "check failed" },
    ] });
    expect(settled.plan?.status).toBe("abandoned");
    expect(settled.modelNote).toContain("NOT successful: 1");
    const completed = await update({ taskId: "t4", state: "done" });
    expect(completed.plan?.status).toBe("completed");
    expect(completed.modelNote).toContain("give your final summary");
    const reopened = await update({ id: "checks", state: "in_progress", note: "rechecking" });
    expect(reopened.plan?.status).toBe("in_progress");
    expect(byId(reopened.plan!, "t2")).toMatchObject({ state: "in_progress", note: "rechecking" });
  });
});

function metaFixture(initial: TaskUpdateWork) {
  const session = createSessionPolicy(sessionId);
  let work = initial;
  const ports = {
    wake: { wakeTurn: false, notificationId: undefined, jobId: undefined, resultRevision: undefined },
    pendingNotifications: () => [],
    matchesWakeRevision: () => false,
    isClaimed: () => false,
    markRead: () => false,
    releaseClaim: vi.fn(),
    queueResponderLedger: vi.fn(),
    handlePlanTool: (call) => handlePlanTool(call, session, { ...ctx, taskWork: work }),
    recordAttempt: vi.fn(),
    showCall: vi.fn(),
    notify: vi.fn(),
    emitToolResult: vi.fn(),
    writeToolOutput: vi.fn(),
    renderPlan: vi.fn(),
    adoptProjectRoot: vi.fn(),
    setPendingSessionStatePlan: vi.fn(),
    clearPlanContext: vi.fn(),
    setTaskWork: vi.fn((next: TaskUpdateWork) => { work = next; }),
  } satisfies MetaToolPorts;
  return {
    ports,
    work: () => work,
    update: (args: ToolCall["args"]) => runMetaTool(ports, { name: "task.update", args }),
  };
}

it.each([false, true])("moves live evidence and publishes only the committed handoff (open listed first: %s)", async (openFirst) => {
  const before = await seedPlan();
  const meta = metaFixture({ ledger: { taskId: "t1", successWorkCount: 5, sawFeatureWrite: true }, looseWork: [] });
  const result = await meta.update({ updates: openFirst ? [open, close] : [close, open] });
  expect(result).toMatchObject({ kind: "handled", result: { ok: true } });
  const committed = (await loadPlan(sessionId))!;
  expect(committed.version).toBe(before.version! + 1);
  expect(byId(committed, "t1").evidence).toEqual({ successWorkCount: 5, sawFeatureWrite: true });
  expect(byId(committed, "t3").evidence).toBeUndefined();
  expect(meta.work().ledger).toEqual({ taskId: "t3", successWorkCount: 0 });
  expect(meta.ports.setTaskWork).toHaveBeenCalledTimes(1);
  expect(meta.ports.renderPlan.mock.calls).toEqual([[committed]]);
  expect(meta.ports.setPendingSessionStatePlan.mock.calls).toEqual([[committed]]);
  expect(meta.ports.emitToolResult).toHaveBeenCalledTimes(1);
  expect(meta.ports.recordAttempt).toHaveBeenCalledTimes(1);
});

it("does not credit a failed attempt to the retried task", async () => {
  await seedPlan();
  const failed = await mutatePlan(sessionId, (draft) => {
    Object.assign(byId(draft, "t2"), { state: "failed", evidence: { successWorkCount: 8 } });
  });
  const looseWork = [{ toolName: "fs.read" }];
  const meta = metaFixture({ ledger: { taskId: "t2", successWorkCount: 9, sawFeatureWrite: true }, looseWork });
  await meta.update({ updates: [{ state: "done", taskIds: ["t1"] }, { state: "in_progress", taskIds: ["t2"] }] });
  const committed = (await loadPlan(sessionId))!;
  expect(committed.version).toBe(failed.plan!.version! + 1);
  expect(byId(committed, "t2").evidence).toBeUndefined();
  expect(meta.work()).toEqual({ ledger: { taskId: "t2", successWorkCount: 0 }, looseWork });
});

it("adopts fitting unassigned work once and retains unmatched receipts", async () => {
  await seedPlan();
  await mutatePlan(sessionId, (draft) => { byId(draft, "t3").title = "Inspect files"; });
  const unmatched = { toolName: "fs.write" };
  const meta = metaFixture({ ledger: null, looseWork: [{ toolName: "fs.read" }, unmatched] });
  await meta.update({ updates: [close, open] });
  await meta.update({ taskId: "t3", state: "in_progress" });
  expect(meta.work()).toEqual({
    ledger: { taskId: "t3", successWorkCount: 1, lastOkTool: "fs.read" },
    looseWork: [unmatched],
  });
  expect(byId((await loadPlan(sessionId))!, "t3").evidence).toEqual({ successWorkCount: 1, lastOkTool: "fs.read" });
});

it("does not put already credited work into the unassigned bank", async () => {
  const plan = await seedPlan();
  const bankLooseWork = vi.fn();
  const persistTaskEvidence = vi.fn().mockResolvedValue(plan);
  const tool = { name: "fs.edit", args: { path: "src/app.ts" } };
  let ledger: TaskUpdateWork["ledger"] = null;
  const ports = {
    getLedger: () => ledger,
    setLedger: (next: TaskUpdateWork["ledger"]) => { ledger = next; },
    bankLooseWork,
    persistTaskEvidence,
  };
  const input = { call: tool, signals: { sourceWrite: true }, creditId: "t1", plan };
  await creditSuccessfulWork(ports, input);
  expect(persistTaskEvidence).toHaveBeenCalledWith("t1", { successWorkCount: 1, lastOkTool: "fs.edit", sawSourceWrite: true });
  expect(bankLooseWork).not.toHaveBeenCalled();
  await creditSuccessfulWork(ports, { ...input, plan: undefined, creditId: undefined });
  expect(bankLooseWork).toHaveBeenCalledWith({ toolName: "fs.edit", signals: { sourceWrite: true } });
});

it("does not overwrite fresher stored evidence with a stale live ledger", async () => {
  await seedPlan();
  const meta = metaFixture({ ledger: { taskId: "t1", successWorkCount: 2 }, looseWork: [] });
  const durable = { successWorkCount: 4, sawSourceWrite: true };
  await mutatePlan(sessionId, (draft) => { byId(draft, "t1").evidence = durable; });
  await meta.update({ updates: [close, open] });
  expect(byId((await loadPlan(sessionId))!, "t1").evidence).toEqual(durable);
});

it.each(["invalid batch", "storage error"])("does not publish a plan or ledger after %s", async (failure) => {
  const before = await seedPlan();
  const work = { ledger: { taskId: "t1", successWorkCount: 8 }, looseWork: [{ toolName: "fs.read" }] };
  const meta = metaFixture(work);
  if (failure === "storage error") {
    vi.spyOn(planStore, "mutatePlan").mockRejectedValueOnce(new Error("storage unavailable"));
  }
  const args = failure === "invalid batch" ? { updates: [close, { ...open, taskIds: ["missing"] }] } : { updates: [close, open] };
  const result = await meta.update(args);
  expect(result).toMatchObject({ kind: "handled", result: { ok: false } });
  expect(meta.work()).toBe(work);
  expect(meta.ports.setTaskWork).not.toHaveBeenCalled();
  expect(meta.ports.renderPlan).not.toHaveBeenCalled();
  expect(meta.ports.setPendingSessionStatePlan).not.toHaveBeenCalled();
  expect(await loadPlan(sessionId)).toEqual(before);
});

it("bounds the total batch size across otherwise valid groups", async () => {
  const before = await seedPlan();
  const result = await update({ updates: [close, { state: "done", taskIds: Array.from({ length: 99 }, (_, i) => `t${i + 3}`) }] });
  expect(result.ok).toBe(false);
  expect(result.modelNote).toContain("at most 100 tasks per call");
  expect(await loadPlan(sessionId)).toEqual(before);
});

it("returns an actionable error if there is no active plan", async () => {
  const result = await update({ updates: [close, open] });
  expect(result.ok).toBe(false);
  expect(result.modelNote).toContain("no active plan. Call plan.create first");
});

const saveMutation = planStore.mutatePlan;

it("reprojects a retried commit from the fresh draft without replaying evidence", async () => {
  const before = await seedPlan();
  const meta = metaFixture({ ledger: null, looseWork: [{ toolName: "fs.read" }] });
  vi.spyOn(planStore, "mutatePlan").mockImplementationOnce(async (id, reducer) => {
    const discarded = structuredClone(before);
    expect(reducer(discarded)).toBe(true);
    await saveMutation(id, (draft) => { byId(draft, "t4").note = "concurrent writer"; });
    return saveMutation(id, reducer);
  });
  const result = await meta.update({ updates: [close, open] });
  expect(result).toMatchObject({ kind: "handled", result: { ok: true } });
  const committed = (await loadPlan(sessionId))!;
  expect(committed.version).toBe(before.version! + 2);
  expect(byId(committed, "t4").note).toBe("concurrent writer");
  expect(byId(committed, "t3").evidence?.successWorkCount).toBe(1);
  expect(meta.work().looseWork).toEqual([]);
  expect(meta.ports.setTaskWork).toHaveBeenCalledTimes(1);
});
