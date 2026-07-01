import chalk from "chalk";
import {
  createPlan,
  loadPlan,
  savePlan,
  markTask,
  type SessionPlan,
  type TaskState,
} from "../store/plan.js";
import { renderPlanChecklist, renderPlanSidePane } from "../ui/plan-pane.js";
import type { LoopGuard } from "./loop-guard.js";
import type { SessionPolicy } from "./session-policy.js";
import { isLumpedSingleTask } from "./tool-call-parser.js";
import type { ToolCall } from "../types.js";

/** Render the plan as a right-side pane on wide terminals, else inline. */
export function renderPlanForTerminal(plan: SessionPlan): string {
  const cols = process.stdout.columns ?? 0;
  const side = process.stdout.isTTY
    ? renderPlanSidePane(plan, cols)
    : undefined;
  return side ?? renderPlanChecklist(plan);
}

export interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  /** What to print to the user's terminal. */
  display: string;
  /** What to feed back to the model as the tool result. */
  modelNote: string;
}

/** Build the system-context block describing the session's active plan. */
export function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}`);
  });
  if (approved) {
    const firstPending = plan.tasks.find((t) => t.state === "pending");
    lines.push("The user APPROVED this plan. Execute it task by task NOW.");
    if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done, and do NOT skip ahead to later tasks.",
      );
    }
    lines.push(
      "STRICT ORDER: call task.update {taskId, state:'in_progress'} → do the real work → " +
        "call task.update {taskId, state:'done'} ONLY after the tool calls actually succeed. " +
        "If a tool fails, mark the task 'failed' with a note, fix the problem, then retry. " +
        "Do NOT mark a task done when its commands error out. " +
        "Never claim something ran without a successful tool call.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved, so you MUST NOT execute any of its tasks yet. " +
        "Any new free-text message from the user right now is a PLAN REVISION, not approval — even if it " +
        "sounds like an instruction (e.g. 'do not install new tools', 'use only X', 'also add Y', 'skip task 2'). " +
        "Treat it as feedback: call plan.create AGAIN with the revised goal/detail/tasks to produce an updated " +
        "plan, then STOP and wait. Do NOT call shell.exec, pkg.install, net.scan, tool.check, fs.write, or any " +
        "other execution tool. The user will APPROVE with /implement, or CANCEL with /discard. Only after " +
        "/implement may you begin executing.",
    );
  }
  return lines.join("\n");
}

/**
 * Handle plan.create / task.update inline. These are session-scoped and
 * persisted via the plan store so the user can view the plan (Ctrl+P) and
 * the agent keeps it in context across the whole session.
 */
export async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number },
): Promise<PlanToolResult> {
  void ctx;
  if (call.name === "plan.create") {
    const goal = typeof call.args.goal === "string" ? call.args.goal : "";
    const detail = typeof call.args.detail === "string" ? call.args.detail : "";
    const kind =
      typeof call.args.kind === "string" ? call.args.kind : "general";
    const rawTasks = Array.isArray(call.args.tasks) ? call.args.tasks : [];
    const taskTitles = rawTasks
      .map((t) => (typeof t === "string" ? t : ""))
      .filter(Boolean);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array of step titles.",
      };
    }
    // Reject a low-quality "everything in one step" plan. A single task that
    // itself enumerates many files/actions (commas, "and", slashes) is a sign
    // the model lumped the whole build into one checkbox — split it so the
    // user gets a real, trackable checklist and the executor works step by step.
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into 3-8 SEPARATE, " +
          "ordered tasks — each a distinct action, e.g. 'scaffold package.json + vite config', " +
          "'create index.html + entry (main.jsx)', 'build App + Post components', 'add posts data + styles', " +
          "'install deps and run dev server to verify'. Call plan.create again with that tasks array.",
      };
    }
    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles,
      kind,
    });
    await savePlan(plan).catch(() => undefined);
    // A freshly (re)created plan resets approval — the user must /implement.
    session.planApproved.value = false;
    const checklist = renderPlanForTerminal(plan);
    const display =
      chalk.cyan("  ● planning\n") +
      checklist +
      "\n" +
      chalk.dim(
        "  ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,\n" +
          "    or /discard to cancel it. Any other message refines this plan.\n",
      );
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote:
        `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
        "Do NOT start executing tasks until the user approves with /implement. " +
        "If the user's next message gives feedback instead of /implement, that is a REVISION: call plan.create " +
        "again with the updated plan and STOP again. The user may cancel the whole plan with /discard. " +
        "Only after /implement do you begin, working task by task, calling task.update to mark each " +
        "in_progress before and done after you finish it.",
    };
  }

  // task.update
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        "  ✗ task.update: no active plan — call plan.create first\n",
      ),
      modelNote:
        "task.update failed: there is no active plan. Call plan.create first.",
    };
  }
  const taskId = typeof call.args.taskId === "string" ? call.args.taskId : "";
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
  // Only one task may be in_progress at a time. This forces genuine
  // task-by-task execution: the model must close (done/failed/skipped) the
  // current task before opening the next one, instead of leaving a task
  // "in_progress" as an umbrella while it quietly works through the rest
  // of the plan underneath it.
  if (stateRaw === "in_progress") {
    const otherInProgress = plan.tasks.find(
      (t) => t.id !== taskId && t.state === "in_progress",
    );
    if (otherInProgress) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  \u2717 task.update: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress\n`,
        ),
        modelNote:
          `task.update failed: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress. ` +
          "Finish it first \u2014 call task.update with state 'done' (or 'failed'/'skipped' with a note) " +
          `for [${otherInProgress.id}] before starting [${taskId}].`,
      };
    }
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const ids = plan.tasks.map((t) => t.id).join(", ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskId}" (have: ${ids})\n`,
      ),
      modelNote: `task.update failed: unknown taskId. Valid ids: ${ids}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const allDone = plan.tasks.every(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
  );
  if (allDone) plan.status = "completed";
  await savePlan(plan).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  return {
    handled: true,
    ok: true,
    plan,
    display: checklist + "\n",
    modelNote: allDone
      ? "Task updated. ALL tasks are now finished. Verify the result and give your final summary."
      : "Task updated. Continue with the next pending task.",
  };
}
