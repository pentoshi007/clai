import { appendPlanTask, applyForegroundSnapshot, applySessionPlanOperation, createPlan, deletePlan, isBareTaskIdTitle, isPlanSuccessful, isPlanTerminal, loadPlan, markTask, mutatePlan, normalizeTaskDependencies, readyPlanTasks, savePlan, validateSessionPlan } from "../../store/plan.js";
import type { SessionPlan, TaskState } from "../../store/plan.js";
import { evaluateTaskTransition } from "../../store/task-transitions.js";
import type { ToolCall } from "../../types.js";
import { renderPlanChecklist } from "../../ui/plan-pane.js";
import type { LoopGuard } from "../loop-guard.js";
import { getActiveProjectRoot } from "../project-root.js";
import type { SessionPolicy } from "../session-policy.js";
import { classifyTaskTitle } from "../task-evidence.js";
import { buildDependencyReminder, dependencyToast } from "../task-sync.js";
import { isLumpedSingleTask } from "../tool-call-parser.js";
import { detectPackageManager } from "../workspace-orient.js";
import chalk from "chalk";
import { looksLikeRunOnlyGoal, nextTaskId, normalizePlanDetail, normalizePlanGoal, normalizePlanKind, normalizePlanTaskEntries, normalizeTaskTitle, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "./normalization.js";
import { handlePlanCreate } from "./actions/plan-create.js";
import { handlePlanClear } from "./actions/plan-clear.js";
import { handleTaskMove } from "./actions/task-move.js";
import { handleTaskAdd } from "./actions/task-add.js";
export { looksLikeRunOnlyGoal, normalizePlanTaskEntries, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan };
export type { NormalizedPlanTask } from "./normalization.js";

export function normalizeCodingPlanTasks(
  _kind: string,
  _goal: string,
  _detail: string,
  tasks: string[],
): string[] {
  return [...tasks];
}

export function renderPlanForTerminal(plan: SessionPlan): string {
  return renderPlanChecklist(plan);
}

export interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  cleared?: boolean | undefined;
  display: string;
  modelNote: string;
  reminder?: boolean | undefined;
  toast?: string | undefined;
}

export async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number; autoApprove?: boolean },
): Promise<PlanToolResult> {
  const autoApprove = Boolean(ctx.autoApprove);
  void ctx.loopGuard;
  void ctx.step;
  if (!session.pendingDependency) session.pendingDependency = { value: undefined };
  if (!session.pendingTaskBatch) session.pendingTaskBatch = { value: undefined };
  if (call.name === "plan.create") {
    return handlePlanCreate(call, session, autoApprove);
  }

  if (call.name === "plan.clear") {
    return handlePlanClear(call, session, autoApprove);
  }

  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ ${call.name}: no active plan — call plan.create first\n`,
      ),
      modelNote:
        `${call.name} failed: there is no active plan. Call plan.create first.`,
    };
  }

  if (call.name === "task.move") {
    return handleTaskMove(call, session, autoApprove, plan);
  }

  if (call.name === "task.add") {
    return handleTaskAdd(call, session, autoApprove, plan);
  }

  const taskIdRaw =
    typeof call.args.taskId === "string"
      ? call.args.taskId
      : typeof call.args.id === "string"
        ? call.args.id
        : "";
  const stateRaw = typeof call.args.state === "string" ? call.args.state : "";
  const note = typeof call.args.note === "string" ? call.args.note : undefined;
  const validStates: TaskState[] = [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];
  if (!validStates.includes(stateRaw as TaskState)) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: state must be one of ${validStates.join(", ")}\n`,
      ),
      modelNote: `task.update failed: state must be one of ${validStates.join(", ")}.`,
    };
  }
  const taskId = resolvePlanTaskId(plan, taskIdRaw) ?? taskIdRaw;
  const taskTarget = plan.tasks.find((task) => task.id === taskId);
  if (taskTarget?.responderOwned) {
    return {
      handled: true,
      ok: false,
      display: chalk.yellow(
        `  ⚠ task.update: [${taskId}] is owned by Responder job ${taskTarget.jobId ?? "?"}\n`,
      ),
      modelNote:
        `task.update held: [${taskId}] is a Responder-owned background-job subtask. ` +
        `Do not change it manually; continue independent work or yield. Responder will advance it from the real process result and wake you when analysis is actionable.`,
    };
  }
  
  let dependencyWarning: string | undefined;
  let dependencyWarningToast: string | undefined;

  if (stateRaw === "in_progress") {
    const target = plan.tasks.find((task) => task.id === taskId);
    const ready = readyPlanTasks(plan).some((task) => task.id === taskId);
    const retryingFailedTask = target?.state === "failed";
    if (target?.state === "done" || target?.state === "skipped") {
      const nextPending = readyPlanTasks(plan)[0];
      const nextHint = nextPending
        ? ` Continue with task.update {taskId:"${nextPending.id}", state:"in_progress"} ("${nextPending.title}").`
        : " All ready work is finished — write the final summary if needed.";
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  ✗ task.update: [${taskId}] is already ${target.state} — do not re-open\n`,
        ),
        modelNote:
          `task.update failed: [${taskId}] is already ${target.state}. ` +
          `Do not re-run completed tasks.${nextHint}`,
      };
    }
    if (target?.state !== "in_progress") {
      const otherActive = plan.tasks.find(
        (task) =>
          task.id !== taskId &&
          task.state === "in_progress" &&
          !task.responderOwned,
      );
      if (otherActive) {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${otherActive.id}] is still in progress — only one foreground task may be active\n`,
          ),
          modelNote:
            `task.update failed: [${otherActive.id}] "${otherActive.title}" is still in_progress. ` +
            `Defer it first with task.update {taskId:"${otherActive.id}", state:"pending"} (or finish it with "done"; use "failed"/"skipped" with a reason), then open [${taskId}]. ` +
            `Exactly one foreground task may be active at a time; Responder-owned subtasks are exempt.`,
        };
      }
      const incompleteDependencies = (target?.dependencies ?? []).filter((dependency) => {
        const dependencyTask = plan.tasks.find((task) => task.id === dependency);
        return !dependencyTask || (dependencyTask.state !== "done" && dependencyTask.state !== "skipped");
      });
      const heldLocks = new Set(
        plan.tasks
          .filter((task) => task.state === "in_progress" && task.id !== taskId)
          .flatMap((task) => task.resourceLocks ?? []),
      );
      const conflictingLocks = (target?.resourceLocks ?? []).filter((lock) => heldLocks.has(lock));
      if (
        target &&
        incompleteDependencies.length > 0 &&
        !retryingFailedTask &&
        conflictingLocks.length === 0
      ) {
        dependencyWarning = buildDependencyReminder({
          taskId,
          title: target.title,
          targetState: stateRaw,
          blockers: incompleteDependencies.map((id) => ({
            id,
            title: plan.tasks.find((task) => task.id === id)?.title ?? "",
          })),
        });
        dependencyWarningToast = dependencyToast(taskId);
      } else if ((!ready && !retryingFailedTask) || conflictingLocks.length > 0) {
        const nextReady = readyPlanTasks(plan)[0];
        return {
          handled: true,
          ok: false,
          display: chalk.red(`  ✗ task.update: [${taskId}] is not dependency/resource ready\n`),
          modelNote:
            `task.update failed: [${taskId}] is not ready. ` +
            (incompleteDependencies.length ? `Incomplete dependencies: ${incompleteDependencies.join(", ")}. ` : "") +
            (conflictingLocks.length ? `Resources currently locked: ${conflictingLocks.join(", ")}. ` : "") +
            (nextReady
              ? `Open the next ready task first: ${nextReady.id} ("${nextReady.title}").`
              : ""),
        };
      }
    }
    if (retryingFailedTask && target) target.evidence = undefined;
  }
  if (stateRaw === "done") {
    const target = plan.tasks.find((task) => task.id === taskId);
    const incompleteDependencies = (target?.dependencies ?? []).filter((dependency) => {
      const dependencyTask = plan.tasks.find((task) => task.id === dependency);
      return !dependencyTask || (dependencyTask.state !== "done" && dependencyTask.state !== "skipped");
    });
    if (incompleteDependencies.length > 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(`  ✗ task.update: cannot complete [${taskId}] before dependencies\n`),
        modelNote: `task.update failed: earlier task/dependency ${incompleteDependencies.join(", ")} is not complete for [${taskId}].`,
      };
    }
    if (target && target.state !== "in_progress") {
      if (target.state === "pending" && incompleteDependencies.length === 0) {
        const opened = markTask(plan, taskId, "in_progress", note);
        if (!opened) {
          return {
            handled: true,
            ok: false,
            display: chalk.red(
              `  ✗ task.update: could not auto-open [${taskId}] before completion\n`,
            ),
            modelNote: `task.update failed: could not auto-open pending [${taskId}].`,
          };
        }
      } else if (target.state === "failed") {
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${taskId}] is failed — retry with in_progress first\n`,
          ),
          modelNote:
            `task.update failed: [${taskId}] is failed. ` +
            `Call task.update {taskId:"${taskId}", state:"in_progress"} to retry, then mark done after recovery work.`,
        };
      } else {
        const nextReady = readyPlanTasks(plan)[0];
        return {
          handled: true,
          ok: false,
          display: chalk.red(
            `  ✗ task.update: [${taskId}] must be in_progress before completion\n`,
          ),
          modelNote:
            `task.update failed: [${taskId}] is ${target.state}. ` +
            "Start or retry it, perform fresh work, then mark it done." +
            (nextReady
              ? ` Open next ready: ${nextReady.id} ("${nextReady.title}").`
              : ""),
        };
      }
    }
  }
  const transitionTarget = plan.tasks.find((task) => task.id === taskId);
  if (transitionTarget) {
    const verdict = evaluateTaskTransition(
      transitionTarget.state,
      stateRaw as TaskState,
    );
    if (!verdict.allowed) {
      const nextReady = readyPlanTasks(plan)[0];
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  ✗ task.update: [${taskId}] ${transitionTarget.state} → ${stateRaw} is not a valid transition\n`,
        ),
        modelNote:
          `task.update failed: [${taskId}] ${verdict.reason}. ` +
          (nextReady
            ? `Continue with ${nextReady.id} ("${nextReady.title}").`
            : "All ready work is finished — write the final summary if needed."),
      };
    }
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const idMap = plan.tasks
      .map(
        (t) =>
          `${t.id}="${t.title}"` +
          (t.aliases?.length ? ` (also: ${t.aliases.join(", ")})` : ""),
      )
      .join("; ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskIdRaw}" (have: ${plan.tasks.map((t) => t.id).join(", ")})\n`,
      ),
      modelNote:
        `task.update failed: unknown taskId "${taskIdRaw}". ` +
        `Valid ids (use these, not title text): ${idMap}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const terminal = isPlanTerminal(plan);
  const successful = isPlanSuccessful(plan);
  if (terminal) plan.status = successful ? "completed" : "abandoned";
  const committedStates = new Map(
    plan.tasks.map((task) => [
      task.id,
      { state: task.state, note: task.note },
    ]),
  );
  await mutatePlan(plan.sessionId, (draft) => {
    for (const task of draft.tasks) {
      const desired = committedStates.get(task.id);
      if (!desired) continue;
      if (task.responderOwned) continue;
      task.state = desired.state;
      if (desired.note !== undefined) task.note = desired.note;
    }
    draft.status = plan.status;
    return true;
  }).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  const nextPending = readyPlanTasks(plan)[0];
  let modelNote: string;
  if (successful) {
    modelNote =
      "Task updated. All required tasks succeeded or were explicitly skipped. Verify the result and give your final summary. " +
      "If a dev server was started: report URL, port, job id, and that it is still running.";
  } else if (terminal) {
    const failed = plan.tasks.filter((task) => task.state === "failed");
    modelNote =
      `Task updated. The plan is terminal but NOT successful: ${failed.length} task(s) failed. ` +
      "Do not claim completion. Report a failed/partial outcome with the failed tasks and remaining user outcome.";
  } else if (stateRaw === "done" && nextPending) {
    modelNote =
      `Task [${taskId}] marked done after verified work. ` +
      `NEXT: open only the next task with task.update {taskId:"${nextPending.id}", state:"in_progress"}, ` +
      `then do work for "${nextPending.title}" only. Wait for tool results before marking that one done. ` +
      "Do not batch later tasks. Do not start a later task's tools early.";
  } else if (stateRaw === "in_progress") {
    modelNote =
      `Task [${taskId}] is now in_progress and owns the foreground outcome. Choose the method from current evidence, ` +
      `read each result, and keep working until the task's acceptance evidence holds. Capture newly discovered required ` +
      `work with task.add. If a discovery must preempt this task, move [${taskId}] back to pending before opening the ` +
      `higher-priority task; otherwise preserve focus and avoid starting unrelated later work. Mark done only after verification.`;
  } else if (stateRaw === "pending") {
    modelNote =
      `Task [${taskId}] is pending. If you deferred it to switch priorities, ` +
      `explicitly open the intended task with task.update {taskId:"...", state:"in_progress"} before doing work.`;
  } else {
    modelNote = "Task updated. Continue with the next pending task.";
  }
  return {
    handled: true,
    ok: true,
    plan,
    display:
      checklist +
      "\n" +
      (dependencyWarning
        ? chalk.yellow(`  ⚠ ${dependencyWarning}\n`)
        : ""),
    modelNote: dependencyWarning
      ? `${dependencyWarning}\n${modelNote}`
      : modelNote,
    ...(dependencyWarningToast ? { toast: dependencyWarningToast } : {}),
  };
}
