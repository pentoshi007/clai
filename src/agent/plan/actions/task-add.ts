import chalk from "chalk";
import { appendPlanTask, isBareTaskIdTitle, mutatePlan, validateSessionPlan } from "../../../store/plan.js";
import type { PlanTask, SessionPlan } from "../../../store/plan.js";
import type { ToolCall } from "../../../types.js";
import { classifyTaskTitle } from "../../evidence/task-classification.js";
import type { SessionPolicy } from "../../session-policy.js";
import { renderPlanForTerminal, type PlanToolResult } from "../handle-plan-tool.js";
import { normalizeTaskTitle, resolvePlanTaskId, slugifyTaskId } from "../normalization.js";

type TaskArgs = ToolCall["args"];
type PlanEdit = { tasks: TaskArgs[]; goal?: string | undefined; detail?: string | undefined };

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === "string" && Boolean(item.trim()))) return;
  return [...new Set(value.map(item => item.trim()))];
}

function resolveTaskReferences(plan: SessionPlan, args: TaskArgs): Pick<PlanTask, "dependencies" | "parentTaskId"> | string {
  const parent = args.parentTaskId ?? args.parentId;
  const parentTaskId = typeof parent === "string" ? resolvePlanTaskId(plan, parent) : undefined;
  if (parent !== undefined && !parentTaskId) {
    return `unknown parentTaskId "${String(parent)}". Use an existing or earlier task id or alias.`;
  }
  const references = stringArray(args.dependencies ?? args.dependsOn);
  if (!references) return "dependencies must be an array of task ids or aliases.";
  const dependencies = new Set<string>();
  for (const reference of references) {
    const id = resolvePlanTaskId(plan, reference);
    if (!id) return `unknown dependency "${reference}". Use an existing or earlier task id or alias.`;
    dependencies.add(id);
  }
  return { parentTaskId, dependencies: [...dependencies] };
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function resolveTaskAddInput(plan: SessionPlan, args: TaskArgs): Omit<PlanTask, "id"> | string {
  const title = normalizeTaskTitle(args);
  if (!title || isBareTaskIdTitle(title)) return "provide a descriptive title, not a bare task id.";
  const references = resolveTaskReferences(plan, args);
  if (typeof references === "string") return references;
  const resourceLocks = stringArray(args.resourceLocks ?? args.resources);
  if (!resourceLocks) return "resourceLocks must be an array of non-empty strings.";
  const acceptance = args.acceptanceCriteria ?? args.acceptance;
  const { note } = args;
  if (!optionalText(acceptance) || !optionalText(note)) return "acceptanceCriteria and note must be strings.";
  return {
    ...references,
    title,
    state: "pending",
    note,
    acceptanceCriteria: acceptance?.trim(),
    aliases: [slugifyTaskId(title)].filter(Boolean),
    resourceLocks,
  };
}

function needsTask(plan: SessionPlan, task: PlanTask, id: string): boolean {
  const dependencies = new Set(task.dependencies);
  for (const dependency of dependencies) {
    if (dependency === id) return true;
    const prerequisite = plan.tasks.find(candidate => candidate.id === dependency);
    for (const upstream of prerequisite?.dependencies ?? []) dependencies.add(upstream);
  }
  return false;
}

function deferUnfinishedReport(plan: SessionPlan, task: PlanTask): string | undefined {
  const isReport = (candidate: PlanTask): boolean =>
    classifyTaskTitle(candidate.title, { planKind: plan.kind }) === "report";
  if (isReport(task)) return;
  const report = plan.tasks.find((candidate) =>
    !candidate.responderOwned && candidate.state !== "done" && candidate.state !== "skipped" && isReport(candidate),
  );
  if (!report || needsTask(plan, task, report.id)) return;

  plan.tasks.splice(plan.tasks.indexOf(task), 1);
  plan.tasks.splice(plan.tasks.indexOf(report), 0, task);
  report.dependencies = [...new Set([...(report.dependencies ?? []), task.id])];
  if (report.state === "in_progress") report.state = "pending";
  const deferral = `deferred for newly discovered work ${task.id}`;
  report.note = report.note ? `${report.note}; ${deferral}` : deferral;
  return report.id;
}

function readTaskBatch(value: unknown): TaskArgs[] | string {
  if (!Array.isArray(value) || value.length === 0) return "tasks must be a non-empty array.";
  const tasks: TaskArgs[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") {
      tasks.push({ title: entry });
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return `task ${index + 1} must be a title or task object.`;
    tasks.push(entry as TaskArgs);
  }
  return tasks;
}

function readPlanMetadata({ goal: rawGoal, detail }: TaskArgs): Omit<PlanEdit, "tasks"> | string {
  const goal = typeof rawGoal === "string" ? rawGoal.trim().replace(/\s+/g, " ") : undefined;
  if (rawGoal !== undefined && (!goal || goal.length > 80)) return "goal must be a short title, at most 80 characters.";
  if (!optionalText(detail)) return "detail must be a string.";
  return { goal, detail: detail?.trim() };
}

function readPlanEdit({ name, args }: ToolCall): PlanEdit | string {
  if (name === "task.add") {
    if (!("tasks" in args)) return { tasks: [args] };
    if (Object.keys(args).length !== 1) return "use either tasks or the single-task fields, not both.";
  }
  const metadata = readPlanMetadata(args);
  if (typeof metadata === "string") return metadata;
  const { tasks: rawTasks } = args;
  if ([metadata.goal, metadata.detail, rawTasks].every(value => value === undefined)) return "provide a goal, detail or tasks.";
  const tasks = rawTasks === undefined ? [] : readTaskBatch(rawTasks);
  return typeof tasks === "string" ? tasks : { ...metadata, tasks };
}

type AppliedEdit = { added: PlanTask[]; reports: Set<string> };

function applyPlanEdit(draft: SessionPlan, edit: PlanEdit, approved: boolean): AppliedEdit | string {
  const added: PlanTask[] = [];
  const reports = new Set<string>();
  for (const args of edit.tasks) {
    const input = resolveTaskAddInput(draft, args);
    if (typeof input === "string") return `task ${added.length + 1}: ${input}`;
    const task = appendPlanTask(draft, input);
    added.push(task);
    const report = deferUnfinishedReport(draft, task);
    if (report) reports.add(report);
  }
  draft.goal = edit.goal ?? draft.goal;
  draft.detail = edit.detail ?? draft.detail;
  if (added.length && approved && draft.status === "approved") draft.status = "in_progress";
  const validation = validateSessionPlan(draft);
  return validation.ok ? { added, reports } : validation.reason;
}

function planEditFailure(name: string, reason: string): PlanToolResult {
  return { handled: true, ok: false, display: chalk.red(`  ✗ ${name}: ${reason}\n`), modelNote: `${name} failed: ${reason}` };
}

function describePlanEdit(edit: PlanEdit, applied: AppliedEdit, plan: SessionPlan): string {
  const notes: string[] = [];
  if (edit.goal !== undefined) notes.push(`Plan title: "${plan.goal}".`);
  if (edit.detail !== undefined) notes.push("Plan detail updated.");
  if (applied.added.length) {
    notes.push(`Added ${applied.added.map(task => `[${task.id}] "${task.title}"`).join(", ")} without rewriting existing tasks.`);
  }
  if (applied.reports.size) notes.push(`Report task(s) ${[...applied.reports].join(", ")} deferred behind new work.`);
  notes.push(plan.status === "draft"
    ? "The plan still needs approval; do not execute tasks yet."
    : "Preserve completed work. Continue the current task or use task.update to open the next ready task.");
  return notes.join(" ");
}

export async function handlePlanEdit(call: ToolCall, session: SessionPolicy): Promise<PlanToolResult> {
  const edit = readPlanEdit(call);
  if (typeof edit === "string") return planEditFailure(call.name, edit);
  let applied: AppliedEdit | string | undefined;
  const committed = await mutatePlan(session.sessionId, (draft) => {
    applied = applyPlanEdit(draft, edit, session.planApproved.value);
    return typeof applied !== "string";
  });
  if (typeof applied === "string") return planEditFailure(call.name, applied);
  if (committed.reason === "missing-plan") return planEditFailure(call.name, "no active plan. Call plan.create first.");
  if (!committed.ok || !committed.plan || !applied) {
    return planEditFailure(call.name, `the edit was not durably committed (${committed.reason ?? "persist-failed"}). Reload the active plan before retrying.`);
  }
  return {
    handled: true,
    ok: true,
    plan: committed.plan,
    display: renderPlanForTerminal(committed.plan) + "\n",
    modelNote: describePlanEdit(edit, applied, committed.plan),
  };
}
