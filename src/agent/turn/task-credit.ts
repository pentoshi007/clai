import type { ToolCall } from "../../types.js";
import type { SessionPlan, TaskEvidence } from "../../store/plan.js";
import { readyPlanTasks } from "../../store/plan.js";
import {
  absorbLooseWorkIntoLedger,
  ledgerFromTaskEvidence,
  recordTaskWorkSuccess,
  taskEvidenceFromLedger,
  type LooseWorkReceipt,
  type TaskWorkLedger,
  type TaskWorkSignals,
} from "../task-evidence.js";

export interface TaskCreditPorts {
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
  readonly bankLooseWork: (receipt: LooseWorkReceipt) => void;
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<SessionPlan>;
}

const absorbIntoReadyTask = async (
  ports: TaskCreditPorts,
  plan: SessionPlan,
  call: ToolCall,
  signals: TaskWorkSignals,
): Promise<SessionPlan | undefined> => {
  const ready = readyPlanTasks(plan)[0];
  if (!ready) return;
  const base = ledgerFromTaskEvidence(ready.id, ready.evidence);
  const absorbed = absorbLooseWorkIntoLedger(
    base,
    ready.id,
    ready.title,
    [{ toolName: call.name, signals }],
    { planKind: plan.kind },
  );
  if (!absorbed || absorbed === base) return;
  const task = plan.tasks.find((candidate) => candidate.id === ready.id);
  if (!task) return;
  task.evidence = taskEvidenceFromLedger(absorbed);
  const live = ports.getLedger();
  if (
    !live ||
    live.taskId !== ready.id ||
    live.successWorkCount < absorbed.successWorkCount
  ) {
    ports.setLedger(absorbed);
  }
  return ports.persistTaskEvidence(task.id, task.evidence);
};

const persistCreditedTask = async (
  ports: TaskCreditPorts,
  plan: SessionPlan,
  creditId: string,
): Promise<SessionPlan | undefined> => {
  const ledger = ports.getLedger();
  if (ledger?.taskId !== creditId) return;
  const task = plan.tasks.find((candidate) => candidate.id === creditId);
  if (!task) return;
  task.evidence = taskEvidenceFromLedger(ledger);
  return ports.persistTaskEvidence(task.id, task.evidence);
};

export const creditSuccessfulWork = async (
  ports: TaskCreditPorts,
  input: {
    readonly call: ToolCall;
    readonly signals: TaskWorkSignals;
    readonly creditId: string | undefined;
    readonly plan: SessionPlan | undefined;
  },
): Promise<SessionPlan | undefined> => {
  const { call, signals, creditId, plan } = input;
  const ledger = recordTaskWorkSuccess(ports.getLedger(), creditId, call.name, signals);
  ports.setLedger(ledger);
  if (plan) {
    const committed = creditId && ledger?.taskId === creditId
      ? await persistCreditedTask(ports, plan, creditId)
      : await absorbIntoReadyTask(ports, plan, call, signals);
    if (committed) return committed;
  }
  ports.bankLooseWork({
    toolName: call.name,
    ...(Object.keys(signals).length > 0 ? { signals } : {}),
  });
  return undefined;
};
