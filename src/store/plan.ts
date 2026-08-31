import { rm } from "node:fs/promises";
import { handlePermissionError, safeExists } from "../os/permissions.js";
import { evaluateTaskTransition } from "./task-transitions.js";
import { applyPlanOperation, type PlanOperation, type VersionedPlanStep } from "../agent/task-plan.js";
import { PlanMeta, PlanStatus, PlanTask, SessionPlan, TaskState, loadDatabase } from "./plan/sqlite-backend.js";
import { jsonlFile, readAllJsonl, withJsonlLock, writeJsonlAtomic } from "./plan/jsonl-backend.js";
import { shortenPlanGoal } from "./plan/task-normalization.js";
import { isBareTaskIdTitle, toVersionedTaskPlan } from "./plan/mutation.js";
export { activeForegroundTasks, enforcePlanInvariants, loadPlan, mutatePlan, savePlan, stripBareTaskIdTasks, validateSessionPlan } from "./plan/mutation.js";
export { isBareTaskIdTitle };
export type { PlanMutationResult } from "./plan/mutation.js";
export { appendPlanTask, applyForegroundSnapshot, nextPlanTaskId, normalizeTaskDependencies } from "./plan/task-normalization.js";
export { shortenPlanGoal };
export type { PlanMeta, PlanStatus, PlanTask, SessionPlan, TaskEvidence, TaskState } from "./plan/sqlite-backend.js";

/**
 * Session-scoped plan + task persistence.
 *
 * A plan is a comprehensive, human-readable description of HOW the agent
 * intends to accomplish a multi-step goal (coding OR pentesting), paired
 * with an ordered checklist of tasks. The agent has the plan in context for
 * the whole session, marks tasks done as it completes them, and the user can
 * view it in a pager (Ctrl+P) or approve execution with /implement.
 *
 * Storage mirrors history.ts: SQLite when better-sqlite3 is available,
 * otherwise an always-present JSONL log. Plans are keyed by a session id so
 * each REPL session keeps its own plan, and resuming a session reloads it.
 */

function newTaskId(index: number): string {
  return `t${index + 1}`;
}

export function tasksFromTitles(titles: string[]): PlanTask[] {
  return titles
    .map((title) => title.trim())
    .filter((title) => Boolean(title) && !isBareTaskIdTitle(title))
    .map((title, index) => ({
      id: newTaskId(index),
      title,
      state: "pending" as TaskState,
      dependencies: index > 0 ? [newTaskId(index - 1)] : [],
      resourceLocks: [],
    }));
}

export function createPlan(input: {
  sessionId: string;
  goal: string;
  detail: string;
  taskTitles: string[];
  kind?: string | undefined;
  meta?: PlanMeta | undefined;
}): SessionPlan {
  const now = new Date().toISOString();
  const plan: SessionPlan = {
    schemaVersion: 2,
    version: 1,
    sessionId: input.sessionId,
    goal: shortenPlanGoal(input.goal) || "Untitled plan",
    detail: input.detail.trim(),
    tasks: tasksFromTitles(input.taskTitles),
    status: "draft",
    kind: input.kind?.trim() || "general",
    createdAt: now,
    updatedAt: now,
  };
  if (input.meta && Object.keys(input.meta).length > 0) {
    plan.meta = input.meta;
  }
  return plan;
}

export function patchPlanMeta(
  plan: SessionPlan,
  patch: PlanMeta,
): SessionPlan {
  plan.meta = { ...(plan.meta ?? {}), ...patch };
  return plan;
}

export async function deletePlan(sessionId: string): Promise<void> {
  try {
    const db = await loadDatabase();
    if (db) {
      db.prepare("DELETE FROM plans WHERE session_id = ?").run(sessionId);
      return;
    }
    await withJsonlLock(async () => {
      const existing = await readAllJsonl();
      const remaining = existing.filter((p) => p.sessionId !== sessionId);
      if (remaining.length === existing.length) return;
      await writeJsonlAtomic(remaining);
    });
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export async function clearAllPlans(): Promise<void> {
  const db = await loadDatabase();
  if (db) {
    try {
      db.exec("DELETE FROM plans;");
    } catch {
      /* ignore */
    }
  }
  if (await safeExists(jsonlFile)) {
    try {
      await rm(jsonlFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

// Task mutations

const fromDomainStatus = (state: VersionedPlanStep["status"]): TaskState =>
  state === "running" ? "in_progress" : state;

export function applySessionPlanOperation(
  plan: SessionPlan,
  operation: PlanOperation,
): SessionPlan {
  const updated = applyPlanOperation(toVersionedTaskPlan(plan), operation);
  const prior = new Map(plan.tasks.map((task) => [task.id, task]));
  return {
    ...plan,
    version: updated.version,
    updatedAt: updated.updatedAt,
    tasks: updated.steps.map((step) => ({
      id: step.id,
      title: step.title,
      state: fromDomainStatus(step.status),
      note: step.notes,
      evidence: prior.get(step.id)?.evidence,
      aliases: prior.get(step.id)?.aliases,
      dependencies: [...(step.dependencies ?? [])],
      resourceLocks: [...(step.resourceLocks ?? [])],
      supersededBy: step.supersededBy,
      parentTaskId: step.parentTaskId,
      jobId: step.jobId,
      processId: step.processId,
      responderOwned: step.responderOwned,
    })),
  };
}

export function readyPlanTasks(plan: SessionPlan): PlanTask[] {
  const done = new Set(
    plan.tasks
      .filter((task) => task.state === "done" || task.state === "skipped")
      .map((task) => task.id),
  );
  const held = new Set(
    plan.tasks
      .filter((task) => task.state === "in_progress" && !task.responderOwned)
      .flatMap((task) => task.resourceLocks ?? []),
  );
  return plan.tasks.filter(
    (task) =>
      task.state === "pending" &&
      !task.responderOwned &&
      !task.supersededBy &&
      (task.dependencies ?? []).every((dependency) => done.has(dependency)) &&
      !(task.resourceLocks ?? []).some((resource) => held.has(resource)),
  );
}

/**
 * Apply a task transition. Rejects transitions the  table forbids so no
 * caller can rewind terminal work; use a plan revision to supersede a task.
 */
export function markTask(
  plan: SessionPlan,
  taskId: string,
  state: TaskState,
  note?: string | undefined,
): boolean {
  const task = plan.tasks.find((t) => t.id === taskId);
  if (!task) return false;
  if (!evaluateTaskTransition(task.state, state).allowed) return false;
  task.state = state;
  if (note !== undefined) task.note = note;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return true;
}

/** Mark the first not-yet-finished foreground task as the given state. */
export function markNextTask(plan: SessionPlan, state: TaskState): PlanTask | undefined {
  const task = plan.tasks.find(
    (candidate) =>
      !candidate.responderOwned &&
      (candidate.state === "pending" || candidate.state === "in_progress"),
  );
  if (!task) return undefined;
  task.state = state;
  plan.version = (plan.version ?? 1) + 1;
  plan.updatedAt = new Date().toISOString();
  return task;
}

/** Tasks the model owns. Responder children advance from process lifecycle. */
export function foregroundTasks(plan: SessionPlan): PlanTask[] {
  return plan.tasks.filter((task) => !task.responderOwned);
}

/** Foreground work that is neither settled nor skipped, in plan order. */
export function foregroundRemaining(plan: SessionPlan): PlanTask[] {
  return foregroundTasks(plan).filter(
    (task) => task.state === "pending" || task.state === "in_progress",
  );
}

/** The single active foreground task, or the next one to resume. */
export function foregroundActiveTask(plan: SessionPlan): PlanTask | undefined {
  const remaining = foregroundRemaining(plan);
  return (
    remaining.find((task) => task.state === "in_progress") ?? remaining[0]
  );
}

/** Responder children that are still running or awaiting analysis. */
export function responderOpenTasks(plan: SessionPlan): PlanTask[] {
  return plan.tasks.filter(
    (task) =>
      task.responderOwned &&
      (task.state === "pending" || task.state === "in_progress"),
  );
}

export function planProgress(plan: SessionPlan): { done: number; total: number } {
  const foreground = foregroundTasks(plan);
  const done = foreground.filter((task) => task.state === "done").length;
  return { done, total: foreground.length };
}

export function isPlanTerminal(plan: SessionPlan): boolean {
  const foreground = foregroundTasks(plan);
  return (
    foreground.length > 0 &&
    foreground.every(
      (task) =>
        task.state === "done" ||
        task.state === "skipped" ||
        task.state === "failed",
    )
  );
}

export function isPlanSuccessful(plan: SessionPlan): boolean {
  const foreground = foregroundTasks(plan);
  return (
    foreground.length > 0 &&
    foreground.every(
      (task) => task.state === "done" || task.state === "skipped",
    )
  );
}

/** @deprecated Use isPlanTerminal or isPlanSuccessful explicitly. */
export function isPlanComplete(plan: SessionPlan): boolean {
  return isPlanSuccessful(plan);
}
