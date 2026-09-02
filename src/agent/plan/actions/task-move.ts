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

export async function handleTaskMove(
  call: ToolCall,
  session: SessionPolicy,
  autoApprove: boolean,
  plan: SessionPlan,
): Promise<PlanToolResult> {
  void autoApprove;
    const taskRaw =
      typeof call.args.taskId === "string" ? call.args.taskId.trim() : "";
    const taskId = resolvePlanTaskId(plan, taskRaw) ?? taskRaw;
    const beforeRaw =
      typeof call.args.beforeTaskId === "string"
        ? call.args.beforeTaskId.trim()
        : "";
    const afterRaw =
      typeof call.args.afterTaskId === "string"
        ? call.args.afterTaskId.trim()
        : "";
    const position =
      typeof call.args.position === "number" ? call.args.position : undefined;
    const selectors = [Boolean(beforeRaw), Boolean(afterRaw), position !== undefined]
      .filter(Boolean).length;
    if (!plan.tasks.some((task) => task.id === taskId) || selectors !== 1) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ task.move needs a valid taskId and exactly one destination\n"),
        modelNote:
          "task.move failed: use a valid taskId plus exactly one of position, beforeTaskId, or afterTaskId.",
      };
    }
    const remaining = plan.tasks.filter((task) => task.id !== taskId);
    let index = 0;
    if (position !== undefined) {
      if (!Number.isInteger(position) || position < 1) {
        return {
          handled: true,
          ok: false,
          display: chalk.red("  ✗ task.move position must be a positive integer\n"),
          modelNote: "task.move failed: position is one-based and must be a positive integer.",
        };
      }
      index = Math.min(position - 1, remaining.length);
    } else {
      const anchorRaw = beforeRaw || afterRaw;
      const anchorId = resolvePlanTaskId(plan, anchorRaw) ?? anchorRaw;
      if (anchorId === taskId || !remaining.some((task) => task.id === anchorId)) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(`  ✗ task.move: invalid anchor "${anchorRaw}"\n`),
          modelNote: `task.move failed: "${anchorRaw}" is not a different task in ACTIVE PLAN.`,
        };
      }
      const anchorIndex = remaining.findIndex((task) => task.id === anchorId);
      index = beforeRaw ? anchorIndex : anchorIndex + 1;
    }
    const updated = applySessionPlanOperation(plan, {
      type: "moveTask",
      expectedVersion: plan.version ?? 1,
      stepId: taskId,
      index,
    });
    await mutatePlan(plan.sessionId, (draft) => {
      applyForegroundSnapshot(draft, updated);
      return true;
    }).catch(() => undefined);
    return {
      handled: true,
      ok: true,
      plan: updated,
      display: renderPlanForTerminal(updated) + "\n",
      modelNote:
        `Moved [${taskId}] to position ${updated.tasks.findIndex((task) => task.id === taskId) + 1}. ` +
        "Task id, state, evidence, dependencies, and responder linkage were preserved.",
    };
}
