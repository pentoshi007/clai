import chalk from "chalk";
import { loadPlan, type SessionPlan } from "../../store/plan.js";
import type { ToolCall } from "../../types.js";
import { renderPlanChecklist } from "../../ui/plan-pane.js";
import type { LoopGuard } from "../loop-guard.js";
import type { SessionPolicy } from "../session-policy.js";
import { looksLikeRunOnlyGoal, normalizePlanTaskEntries, resolvePlanTaskId, slugifyTaskId, titlesMatchForPlan } from "./normalization.js";
import { handlePlanCreate } from "./actions/plan-create.js";
import { handlePlanClear } from "./actions/plan-clear.js";
import { handleTaskMove } from "./actions/task-move.js";
import { handlePlanEdit } from "./actions/task-add.js";
import { handleTaskUpdate, type TaskUpdateWork } from "./actions/task-update.js";
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
  taskWork?: TaskUpdateWork | undefined;
}

export async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number; autoApprove?: boolean; turnEnd?: boolean; taskWork?: TaskUpdateWork },
): Promise<PlanToolResult> {
  const autoApprove = Boolean(ctx.autoApprove);
  void ctx.loopGuard;
  void ctx.step;
  if (call.name === "plan.create") {
    return handlePlanCreate(call, session, autoApprove);
  }

  if (call.name === "plan.clear") {
    return handlePlanClear(call, session, autoApprove);
  }

  if (call.name === "task.update") {
    return handleTaskUpdate(call, session.sessionId, Boolean(ctx.turnEnd), ctx.taskWork);
  }

  if (call.name === "plan.update" || call.name === "task.add") {
    return handlePlanEdit(call, session);
  }

  if (call.name !== "task.move") return { handled: false, ok: false, display: "", modelNote: "" };
  const plan = await loadPlan(session.sessionId);
  if (plan) return handleTaskMove(call, session, autoApprove, plan);
  return {
    handled: true,
    ok: false,
    display: chalk.red("  ✗ task.move: no active plan — call plan.create first\n"),
    modelNote: "task.move failed: there is no active plan. Call plan.create first.",
  };
}
