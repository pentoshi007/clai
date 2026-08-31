import type { PlanToolResult } from "../handle-plan-tool.js";
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

export async function handlePlanClear(
  call: ToolCall,
  session: SessionPolicy,
  autoApprove: boolean,
): Promise<PlanToolResult> {
  void autoApprove;
    const plan = await loadPlan(session.sessionId).catch(() => undefined);
    if (!plan) {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ plan.clear: no active plan to clear\n"),
        modelNote: "plan.clear failed: there is no active plan.",
      };
    }
    const activeResponder = plan.tasks.find(
      (task) =>
        task.responderOwned &&
        (task.state === "pending" || task.state === "in_progress"),
    );
    if (activeResponder) {
      return {
        handled: true,
        ok: false,
        display: chalk.yellow(
          `  ⚠ plan.clear: [${activeResponder.id}] is still owned by an active Responder job\n`,
        ),
        modelNote:
          `plan.clear held: [${activeResponder.id}] "${activeResponder.title}" is still responder-owned and active. ` +
          "Wait for it to settle before clearing the plan so its result is not orphaned.",
      };
    }
    try {
      await deletePlan(session.sessionId);
    } catch {
      return {
        handled: true,
        ok: false,
        display: chalk.red("  ✗ plan.clear: could not remove the active plan\n"),
        modelNote:
          "plan.clear failed: the plan could not be durably removed. The active plan remains unchanged.",
      };
    }
    session.planApproved.value = false;
    return {
      handled: true,
      ok: true,
      cleared: true,
      display: chalk.dim("  ✦ plan cleared — no active plan\n"),
      modelNote:
        "Plan cleared. No active plan exists for this session; the task checklist and approval state were discarded. " +
        "Continue without a plan, or call plan.create only if a fresh durable plan is genuinely needed.",
    };
}
