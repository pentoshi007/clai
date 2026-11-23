import chalk from "chalk";
import { appendPlanTask, isBareTaskIdTitle, mutatePlan, validateSessionPlan } from "../../../store/plan.js";
import type { PlanTask, SessionPlan } from "../../../store/plan.js";
import type { ToolCall } from "../../../types.js";
import { classifyTaskTitle } from "../../evidence/task-classification.js";
import type { SessionPolicy } from "../../session-policy.js";
import { renderPlanForTerminal, type PlanToolResult } from "../handle-plan-tool.js";
import { normalizeTaskTitle, resolvePlanTaskId, slugifyTaskId } from "../normalization.js";

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))];
}

function resolveTaskAddInput(
  plan: SessionPlan,
  title: string,
  args: ToolCall["args"],
): Omit<PlanTask, "id"> | string {
  const parent = [args.parentTaskId, args.parentId].find((value) => typeof value === "string");
  const parentTaskId = parent ? resolvePlanTaskId(plan, parent) : undefined;
  if (parent && !parentTaskId) {
    return `unknown parentTaskId "${parent}". Use a canonical id from ACTIVE PLAN.`;
  }
  const dependencies = stringArray(args.dependencies ?? args.dependsOn)
    .map((dependency) => resolvePlanTaskId(plan, dependency) ?? dependency);
  const unknownDependency = dependencies.find((id) => !plan.tasks.some((task) => task.id === id));
  if (unknownDependency) {
    return `unknown dependency "${unknownDependency}". Use canonical ids from ACTIVE PLAN.`;
  }
  const acceptance = [args.acceptanceCriteria, args.acceptance].find((value) => typeof value === "string");
  return {
    title,
    state: "pending",
    note: typeof args.note === "string" ? args.note : undefined,
    acceptanceCriteria: acceptance?.trim(),
    aliases: [slugifyTaskId(title)].filter(Boolean),
    dependencies,
    resourceLocks: stringArray(args.resourceLocks ?? args.resources),
    parentTaskId,
  };
}

function deferUnfinishedReport(plan: SessionPlan, task: PlanTask): string | undefined {
  const isReport = (candidate: PlanTask): boolean =>
    classifyTaskTitle(candidate.title, { planKind: plan.kind }) === "report";
  if (isReport(task)) return;
  const report = plan.tasks.find((candidate) =>
    !candidate.responderOwned && candidate.state !== "done" && candidate.state !== "skipped" && isReport(candidate),
  );
  if (!report || task.dependencies?.includes(report.id)) return;

  plan.tasks.splice(plan.tasks.indexOf(task), 1);
  plan.tasks.splice(plan.tasks.indexOf(report), 0, task);
  report.dependencies = [...new Set([...(report.dependencies ?? []), task.id])];
  if (report.state === "in_progress") report.state = "pending";
  const deferral = `deferred for newly discovered work ${task.id}`;
  report.note = report.note ? `${report.note}; ${deferral}` : deferral;
  return report.id;
}

function taskAddFailure(reason: string): PlanToolResult {
  return {
    handled: true,
    ok: false,
    display: chalk.red(`  ✗ task.add: ${reason}\n`),
    modelNote: `task.add failed: ${reason}`,
  };
}

export async function handleTaskAdd(
  { args }: ToolCall,
  session: SessionPolicy,
  _autoApprove: boolean,
  plan: SessionPlan,
): Promise<PlanToolResult> {
  let rejection: string | undefined;
  let added: { task: PlanTask; deferredReportId: string | undefined } | undefined;
  const committed = await mutatePlan(plan.sessionId, (draft) => {
    const title = normalizeTaskTitle(args.title ?? args.task ?? args.name);
    if (!title || isBareTaskIdTitle(title)) {
      rejection = "provide a descriptive title, not a bare task id.";
      return false;
    }
    const input = resolveTaskAddInput(draft, title, args);
    if (typeof input === "string") {
      rejection = input;
      return false;
    }
    const task = appendPlanTask(draft, input);
    const deferredReportId = deferUnfinishedReport(draft, task);
    if (session.planApproved.value && draft.status === "approved") draft.status = "in_progress";
    const validation = validateSessionPlan(draft);
    if (!validation.ok) {
      rejection = `${validation.reason}.`;
      return false;
    }
    added = { task, deferredReportId };
    return true;
  });
  if (rejection) return taskAddFailure(rejection);
  if (!committed.ok || !committed.plan || !added) {
    return taskAddFailure(
      `the new task was not durably committed (${committed.reason ?? "persist-failed"}). Reload the active plan before retrying.`,
    );
  }
  const { task, deferredReportId } = added;
  const parent = task.parentTaskId ? ` under [${task.parentTaskId}]` : "";
  const deferral = deferredReportId ? ` Report [${deferredReportId}] was deferred behind this new work.` : "";
  return {
    handled: true,
    ok: true,
    plan: committed.plan,
    display: renderPlanForTerminal(committed.plan) + "\n",
    modelNote:
      `Added [${task.id}] "${task.title}"${parent} without rewriting existing tasks.${deferral} ` +
      "Open it with task.update when it becomes ready. Preserve completed work and continue the current task unless this new task is the immediate evidence-driven next action.",
  };
}
