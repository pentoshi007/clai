import type { PlanToolResult } from "../handle-plan-tool.js";
import { renderPlanForTerminal } from "../handle-plan-tool.js";
import { appendPlanTask, applyForegroundSnapshot, applySessionPlanOperation, createPlan, deletePlan, isBareTaskIdTitle, isPlanSuccessful, isPlanTerminal, loadPlan, markTask, mutatePlan, normalizeTaskDependencies, readyPlanTasks, savePlan, validateSessionPlan } from "../../../store/plan.js";
import type { SessionPlan, TaskState } from "../../../store/plan.js";
import { evaluateTaskTransition } from "../../../store/task-transitions.js";
import type { ToolCall } from "../../../types.js";
import { renderPlanChecklist } from "../../../ui/plan-pane.js";
import type { LoopGuard } from "../../loop-guard.js";
import { getActiveProjectRoot } from "../../project-root.js";
import type { SessionPolicy } from "../../session-policy.js";
import { classifyTaskTitle } from "../../task-evidence.js";
import { buildDependencyReminder, dependencyToast } from "../../task-sync.js";
import { isLumpedSingleTask } from "../../tool-call-parser.js";
import { detectPackageManager } from "../../workspace-orient.js";
import chalk from "chalk";
import { looksLikeRunOnlyGoal, nextTaskId, normalizePlanDetail, normalizePlanGoal, normalizePlanKind, normalizePlanTaskEntries, normalizeTaskTitle, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "../normalization.js";

export async function handleTaskAdd(
  call: ToolCall,
  session: SessionPolicy,
  autoApprove: boolean,
  plan: SessionPlan,
): Promise<PlanToolResult> {
  void autoApprove;
    const title = normalizeTaskTitle(
      call.args.title ?? call.args.task ?? call.args.name,
    );
    if (!title || isBareTaskIdTitle(title)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ task.add needs a descriptive title\n"),
        modelNote: "task.add failed: provide a descriptive title, not a bare task id.",
      };
    }
    const parentRaw =
      typeof call.args.parentTaskId === "string"
        ? call.args.parentTaskId
        : typeof call.args.parentId === "string"
          ? call.args.parentId
          : undefined;
    const parentTaskId = parentRaw
      ? resolvePlanTaskId(plan, parentRaw)
      : undefined;
    if (parentRaw && !parentTaskId) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: unknown parent "${parentRaw}"\n`),
        modelNote: `task.add failed: unknown parentTaskId "${parentRaw}". Use a canonical id from ACTIVE PLAN.`,
      };
    }
    const stringArray = (value: unknown): string[] =>
      Array.isArray(value)
        ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
        : [];
    const dependencies = stringArray(
      call.args.dependencies ?? call.args.dependsOn,
    ).map((dependency) => resolvePlanTaskId(plan, dependency) ?? dependency);
    const unknownDependency = dependencies.find(
      (dependency) => !plan.tasks.some((task) => task.id === dependency),
    );
    if (unknownDependency) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: unknown dependency "${unknownDependency}"\n`),
        modelNote: `task.add failed: unknown dependency "${unknownDependency}". Use canonical ids from ACTIVE PLAN.`,
      };
    }
    const tasksBeforeAdd = plan.tasks.map((candidate) => ({
      ...candidate,
      dependencies: [...(candidate.dependencies ?? [])],
      resourceLocks: [...(candidate.resourceLocks ?? [])],
    }));
    const statusBeforeAdd = plan.status;
    const versionBeforeAdd = plan.version;
    const updatedAtBeforeAdd = plan.updatedAt;
    const task = appendPlanTask(plan, {
      title,
      state: "pending",
      note: typeof call.args.note === "string" ? call.args.note : undefined,
      acceptanceCriteria:
        typeof call.args.acceptanceCriteria === "string"
          ? call.args.acceptanceCriteria.trim()
          : typeof call.args.acceptance === "string"
            ? call.args.acceptance.trim()
            : undefined,
      aliases: [slugifyTaskId(title)].filter(Boolean),
      dependencies,
      resourceLocks: stringArray(
        call.args.resourceLocks ?? call.args.resources,
      ),
      parentTaskId,
    });
    let reportDeferral = "";
    if (classifyTaskTitle(task.title, { planKind: plan.kind }) !== "report") {
      const report = plan.tasks.find(
        (candidate) =>
          !candidate.responderOwned &&
          classifyTaskTitle(candidate.title, { planKind: plan.kind }) === "report",
      );
      if (
        report &&
        report.id !== task.id &&
        report.state !== "done" &&
        report.state !== "skipped" &&
        !task.dependencies?.includes(report.id)
      ) {
        const taskIndex = plan.tasks.findIndex((candidate) => candidate.id === task.id);
        plan.tasks.splice(taskIndex, 1);
        const reportIndex = plan.tasks.findIndex((candidate) => candidate.id === report.id);
        plan.tasks.splice(reportIndex, 0, task);
        report.dependencies = [...new Set([...(report.dependencies ?? []), task.id])];
        if (report.state === "in_progress") report.state = "pending";
        report.note = report.note
          ? `${report.note}; deferred for newly discovered work ${task.id}`
          : `deferred for newly discovered work ${task.id}`;
        reportDeferral = ` Report [${report.id}] was deferred behind this new work.`;
      } else if (report?.state === "done") {
        const update = appendPlanTask(plan, {
          title: `Update final report with findings from ${task.id}`,
          state: "pending",
          aliases: [],
          dependencies: [task.id],
          resourceLocks: [],
          note: `final report update after newly discovered work ${task.id}`,
        });
        reportDeferral = ` Added [${update.id}] to update the completed report after this work.`;
      }
    }
    if (
      session.planApproved.value &&
      (plan.status === "approved" || plan.status === "completed" || plan.status === "abandoned")
    ) {
      plan.status = "in_progress";
    }
    const validation = validateSessionPlan(plan);
    if (!validation.ok) {
      plan.tasks = tasksBeforeAdd;
      plan.status = statusBeforeAdd;
      plan.version = versionBeforeAdd;
      plan.updatedAt = updatedAtBeforeAdd;
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.add: ${validation.reason}\n`),
        modelNote: `task.add failed: ${validation.reason}.`,
      };
    }
    await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, plan);
      return true;
    }).catch(() => undefined);
    return {
      handled: true,
      ok: true,
      plan,
      display: renderPlanForTerminal(plan) + "\n",
      modelNote:
        `Added [${task.id}] "${task.title}"${parentTaskId ? ` under [${parentTaskId}]` : ""} without rewriting existing tasks.${reportDeferral} ` +
        `Open it with task.update when it becomes ready. Preserve completed work and continue the current task unless this new task is the immediate evidence-driven next action.`,
    };
}
