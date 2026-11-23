import chalk from "chalk";
import { isPlanSuccessful, isPlanTerminal, mutatePlan, readyPlanTasks } from "../../../store/plan.js";
import type { PlanMutationResult, PlanTask, SessionPlan, TaskState } from "../../../store/plan.js";
import { parseTaskUpdate, type TaskStateChange } from "../../../tools/task-update.js";
import type { ToolCall } from "../../../types.js";
import {
  absorbLooseWorkIntoLedger,
  ledgerFromTaskEvidence,
  taskEvidenceFromLedger,
  type LooseWorkReceipt,
  type TaskWorkLedger,
} from "../../task-evidence.js";
import { renderPlanForTerminal, type PlanToolResult } from "../handle-plan-tool.js";

export interface TaskUpdateWork {
  readonly ledger: TaskWorkLedger | null;
  readonly looseWork: readonly LooseWorkReceipt[];
}

type ResolvedTaskUpdate = TaskStateChange & { readonly task: PlanTask; readonly previous: TaskState };

function indexAliases(tasks: readonly PlanTask[]): Map<string, PlanTask | null> {
  const aliases = new Map<string, PlanTask | null>();
  for (const task of tasks) {
    for (const alias of task.aliases ?? []) {
      const key = alias.toLowerCase();
      const current = aliases.get(key);
      aliases.set(key, current === undefined || current === task ? task : null);
    }
  }
  return aliases;
}

function resolveUpdates(plan: SessionPlan, changes: readonly TaskStateChange[]): Map<string, ResolvedTaskUpdate> | string {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  let aliases: ReturnType<typeof indexAliases> | undefined;
  const resolved = new Map<string, ResolvedTaskUpdate>();
  for (const change of changes) {
    const task = byId.get(change.taskId) ?? (aliases ??= indexAliases(plan.tasks)).get(change.taskId.toLowerCase());
    if (!task) {
      const problem = task === null ? "ambiguous alias" : "unknown taskId";
      return `${problem} ${JSON.stringify(change.taskId.slice(0, 80))}. Use a canonical id from ACTIVE PLAN.`;
    }
    if (task.responderOwned) {
      return `[${task.id}] is a Responder-owned task. Its job advances it automatically.`;
    }
    if (resolved.has(task.id)) return `duplicate task [${task.id}]. List each task only once.`;
    resolved.set(task.id, { ...change, task, previous: task.state });
  }
  return resolved;
}

function persistLiveEvidence(plan: SessionPlan, ledger: TaskWorkLedger | null): void {
  if (!ledger) return;
  const task = plan.tasks.find((candidate) => candidate.id === ledger.taskId && !candidate.responderOwned);
  if (!task || ledger.successWorkCount <= (task.evidence?.successWorkCount ?? 0)) return;
  task.evidence = taskEvidenceFromLedger(ledger);
}

function applyUpdates(plan: SessionPlan, updates: Iterable<ResolvedTaskUpdate>): void {
  for (const { task, previous, state, note } of updates) {
    if (previous === "failed" && state === "in_progress") task.evidence = undefined;
    task.state = state;
    if (note !== undefined) task.note = note;
  }
  plan.status = "in_progress";
  if (isPlanTerminal(plan)) plan.status = isPlanSuccessful(plan) ? "completed" : "abandoned";
}

function projectTaskWork(
  plan: SessionPlan,
  updates: ReadonlyMap<string, ResolvedTaskUpdate>,
  work: TaskUpdateWork,
): TaskUpdateWork {
  const active = plan.tasks.find((task) => task.state === "in_progress" && !task.responderOwned);
  if (!active) return { ...work, ledger: null };
  const ledger = ledgerFromTaskEvidence(active.id, active.evidence);
  if (updates.get(active.id)?.previous !== "pending" || work.looseWork.length === 0) {
    return { ...work, ledger };
  }
  const credited = absorbLooseWorkIntoLedger(ledger, active.title, work.looseWork, plan.kind);
  if (credited.ledger !== ledger) active.evidence = taskEvidenceFromLedger(credited.ledger);
  return credited;
}

function describeUpdates(updates: Iterable<ResolvedTaskUpdate>): string {
  const groups = new Map<TaskState, string[]>();
  for (const { task, state } of updates) {
    const ids = groups.get(state);
    if (ids) ids.push(task.id);
    else groups.set(state, [task.id]);
  }
  return [...groups].map(([state, ids]) => `${ids.join(", ")} → ${state}`).join("; ");
}

function nextTaskNote(plan: SessionPlan, turnEnd: boolean): string {
  if (plan.status === "completed") {
    const finish = turnEnd ? "give your final summary and call turn.end in the same response" : "give your final summary";
    return `All foreground tasks succeeded or were explicitly skipped. Verify the result and ${finish}. ` +
      "If a dev server was started: report URL, port, job id, and that it is still running.";
  }
  if (plan.status === "abandoned") {
    const failures = plan.tasks.filter((task) => task.state === "failed" && !task.responderOwned);
    return `The plan is terminal but NOT successful: ${failures.length} foreground task(s) failed. ` +
      "Report the failure or partial outcome, not completion.";
  }
  const active = plan.tasks.find((task) => task.state === "in_progress" && !task.responderOwned);
  if (active) return `Continue [${active.id}]. Mark done only after verifying its outcome.`;
  const next = readyPlanTasks(plan)[0];
  if (next) return `Next ready task: [${next.id}]. Open it with task.update before starting work.`;
  return "No foreground task is ready. Check failed tasks and dependencies before continuing.";
}

function taskUpdateFailure(reason: string): PlanToolResult {
  return {
    handled: true,
    ok: false,
    display: chalk.red(`  ✗ task.update: ${reason}\n`),
    modelNote: `task.update failed: ${reason}`,
  };
}

export async function handleTaskUpdate(
  { args }: ToolCall,
  sessionId: string,
  turnEnd: boolean,
  work: TaskUpdateWork | undefined,
): Promise<PlanToolResult> {
  const changes = parseTaskUpdate(args);
  if (typeof changes === "string") return taskUpdateFailure(changes);
  let rejection: string | undefined;
  let taskWork: TaskUpdateWork | undefined;
  let resolved: Map<string, ResolvedTaskUpdate> | undefined;
  const committed = await mutatePlan(sessionId, (draft) => {
    const updates = resolveUpdates(draft, changes);
    if (typeof updates === "string") {
      rejection = updates;
      return false;
    }
    if (work) persistLiveEvidence(draft, work.ledger);
    applyUpdates(draft, updates.values());
    if (work) taskWork = projectTaskWork(draft, updates, work);
    resolved = updates;
    return true;
  }).catch((): PlanMutationResult => ({ ok: false, reason: "persist-failed" }));
  if (rejection) return taskUpdateFailure(rejection);
  if (committed.reason === "missing-plan") return taskUpdateFailure("there is no active plan. Call plan.create first.");
  if (!committed.ok || !committed.plan || !resolved) {
    return taskUpdateFailure(`the plan change was not confirmed (${committed.reason ?? "persist-failed"}). Reload ACTIVE PLAN before retrying.`);
  }
  const plan = committed.plan;
  return {
    handled: true,
    ok: true,
    plan,
    taskWork,
    display: renderPlanForTerminal(plan) + "\n",
    modelNote: `Updated ${describeUpdates(resolved.values())}. ${nextTaskNote(plan, turnEnd)}`,
  };
}
