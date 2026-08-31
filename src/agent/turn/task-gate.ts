import type { SessionPlan } from "../../store/plan.js";
import {
  absorbLooseWorkIntoLedger,
  canMarkTaskDone,
  hasLocalRuntimeProof,
  hasRemoteWorkProof,
  ledgerFromTaskEvidence,
  type LooseWorkReceipt,
  type TaskWorkLedger,
} from "../task-evidence.js";

export interface TaskGatePorts {
  readonly getLiveLedger: () => TaskWorkLedger | null;
  readonly setLiveLedger: (ledger: TaskWorkLedger) => void;
  readonly getLooseWork: () => readonly LooseWorkReceipt[];
  readonly featureAppRequired: boolean;
  readonly existingProject: () => boolean;
}

export const planHasVerifiedRuntime = (plan: SessionPlan): boolean =>
  plan.tasks.some((task) => hasLocalRuntimeProof(task.evidence));

export const planHasVerifiedRemoteWork = (plan: SessionPlan): boolean =>
  plan.tasks.some((task) => hasRemoteWorkProof(task.evidence));

const preferLiveLedger = (
  live: TaskWorkLedger | null,
  durable: TaskWorkLedger,
  taskId: string,
): TaskWorkLedger =>
  live?.taskId === taskId && live.successWorkCount >= durable.successWorkCount
    ? live
    : durable;

const shouldAdoptLedger = (
  live: TaskWorkLedger | null,
  candidate: TaskWorkLedger,
  taskId: string,
): boolean =>
  !live ||
  live.taskId !== taskId ||
  live.successWorkCount < candidate.successWorkCount;

export const resolveLedgerForTaskGate = (
  ports: TaskGatePorts,
  plan: SessionPlan,
  taskId: string,
): TaskWorkLedger | null => {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  const durable = ledgerFromTaskEvidence(taskId, task?.evidence);
  const live = ports.getLiveLedger();
  const ledger = absorbLooseWorkIntoLedger(
    preferLiveLedger(live, durable, taskId),
    taskId,
    task?.title ?? "",
    ports.getLooseWork(),
    { planKind: plan.kind },
  );
  if (
    ledger &&
    ledger.successWorkCount > 0 &&
    shouldAdoptLedger(live, ledger, taskId)
  ) {
    ports.setLiveLedger(ledger);
  }
  return ledger;
};

export const evaluateTaskCompletionGate = (
  ports: TaskGatePorts,
  plan: SessionPlan,
  taskId: string,
): ReturnType<typeof canMarkTaskDone> => {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  const ledger = resolveLedgerForTaskGate(ports, plan, taskId);
  return canMarkTaskDone(ledger, taskId, {
    taskTitle: task?.title,
    featureAppRequired: ports.featureAppRequired,
    existingProject: ports.existingProject(),
    runtimeVerified: planHasVerifiedRuntime(plan),
    planKind: plan.kind,
    remoteWorkVerified: planHasVerifiedRemoteWork(plan),
  });
};
