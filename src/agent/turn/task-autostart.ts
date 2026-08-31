import type { ToolCall } from "../../types.js";
import type { PlanTask, SessionPlan } from "../../store/plan.js";
import { markTask, readyPlanTasks } from "../../store/plan.js";
import {
  isPlanPreflightTool,
  isReadOnlyReconTool,
  ledgerFromTaskEvidence,
  pickPendingTaskForToolCall,
  type TaskWorkLedger,
} from "../task-evidence.js";

export interface TaskAutostartPorts {
  readonly openTask: (taskId: string) => Promise<void>;
  readonly renderPlan: (plan: SessionPlan) => void;
  readonly notify: (message: string) => void;
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
}

const needsAutostart = (plan: SessionPlan): boolean => {
  const unfinished = plan.tasks.some(
    (task) =>
      !task.responderOwned &&
      (task.state === "pending" || task.state === "in_progress"),
  );
  const inProgress = plan.tasks.find(
    (task) => task.state === "in_progress" && !task.responderOwned,
  );
  return unfinished && !inProgress;
};

const gateIsSkipped = (plan: SessionPlan, call: ToolCall): boolean =>
  isPlanPreflightTool(call.name) ||
  (plan.kind === "pentest" && isReadOnlyReconTool(call.name));

export const selectAutostartTask = (
  plan: SessionPlan,
  call: ToolCall,
): PlanTask | undefined => {
  if (!needsAutostart(plan)) return undefined;
  if (gateIsSkipped(plan, call)) return undefined;
  const pending = readyPlanTasks(plan);
  return (
    pickPendingTaskForToolCall(
      pending,
      call,
      plan.tasks.map((task) => task.title),
    ) ?? pending[0]
  );
};

export const autostartPlanTask = async (
  plan: SessionPlan,
  call: ToolCall,
  ports: TaskAutostartPorts,
): Promise<void> => {
  const next = selectAutostartTask(plan, call);
  if (!next) return;
  markTask(plan, next.id, "in_progress");
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  await ports.openTask(next.id);
  const ledger = ports.getLedger();
  if (!ledger || ledger.taskId !== next.id) {
    ports.setLedger(ledgerFromTaskEvidence(next.id, next.evidence));
  }
  ports.renderPlan(plan);
  ports.notify(`auto-started [${next.id}] so work can continue`);
};
