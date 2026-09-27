import type { ToolCall } from "../../types.js";
import type { PlanTask, SessionPlan } from "../../store/plan.js";
import { readyPlanTasks } from "../../store/plan.js";
import {
  isPlanPreflightTool,
  isReadOnlyReconTool,
  ledgerFromTaskEvidence,
  pickPendingTaskForToolCall,
  type TaskWorkLedger,
} from "../task-evidence.js";

export interface TaskAutostartPorts {
  readonly openTask: (taskId: string) => Promise<SessionPlan>;
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
): Promise<SessionPlan | undefined> => {
  const next = selectAutostartTask(plan, call);
  if (!next) return undefined;
  const committed = await ports.openTask(next.id);
  const committedTask = committed.tasks.find((task) => task.id === next.id);
  const ledger = ports.getLedger();
  if (!ledger || ledger.taskId !== next.id) {
    ports.setLedger(ledgerFromTaskEvidence(next.id, committedTask?.evidence));
  }
  ports.renderPlan(committed);
  ports.notify(`auto-started [${next.id}] so work can continue`);
  return committed;
};
