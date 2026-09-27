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
  const absorbed = absorbLooseWorkIntoLedger(
    ledgerFromTaskEvidence(ready.id, ready.evidence),
    ready.id,
    ready.title,
    [{ toolName: call.name, signals }],
    { planKind: plan.kind },
  );
  if (!absorbed || absorbed.successWorkCount === 0) return;
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
  ports.bankLooseWork({
    toolName: input.call.name,
    ...(Object.keys(input.signals).length > 0 ? { signals: input.signals } : {}),
  });
  ports.setLedger(
    recordTaskWorkSuccess(
      ports.getLedger(),
      input.creditId,
      input.call.name,
      input.signals,
    ),
  );
  if (!input.plan) return undefined;
  const ledger = ports.getLedger();
  const creditedElsewhere =
    !input.creditId || !ledger || ledger.taskId !== input.creditId;
  let committed: SessionPlan | undefined;
  if (creditedElsewhere) {
    committed = await absorbIntoReadyTask(
      ports,
      input.plan,
      input.call,
      input.signals,
    );
  }
  if (input.creditId) {
    committed =
      (await persistCreditedTask(ports, input.plan, input.creditId)) ?? committed;
  }
  return committed;
};
