import type { ToolCall } from "../../../types.js";
import type { SessionPlan, TaskEvidence } from "../../../store/plan.js";
import {
  absorbLooseWorkIntoLedger,
  ledgerFromTaskEvidence,
  taskEvidenceFromLedger,
  type LooseWorkReceipt,
  type TaskWorkLedger,
} from "../../task-evidence.js";
import { resolvePlanTaskId } from "../../plan-tool.js";

export interface PlanToolLedgerPorts {
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
  readonly looseWork: () => readonly LooseWorkReceipt[];
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<SessionPlan>;
}

const openTaskLedger = async (
  ports: PlanToolLedgerPorts,
  plan: SessionPlan | undefined,
  taskId: string,
): Promise<SessionPlan | undefined> => {
  const persisted = plan?.tasks.find((task) => task.id === taskId);
  const live = ports.getLedger();
  const base =
    live?.taskId === taskId
      ? live
      : ledgerFromTaskEvidence(taskId, persisted?.evidence);
  const ledger =
    absorbLooseWorkIntoLedger(
      base,
      taskId,
      persisted?.title ?? "",
      ports.looseWork(),
      { planKind: plan?.kind },
    ) ?? base;
  ports.setLedger(ledger);
  if (plan && ledger && ledger.successWorkCount > 0 && persisted) {
    persisted.evidence = taskEvidenceFromLedger(ledger);
    return ports.persistTaskEvidence(persisted.id, persisted.evidence);
  }
};

const completeTaskLedger = async (
  ports: PlanToolLedgerPorts,
  plan: SessionPlan | undefined,
  taskId: string,
): Promise<SessionPlan | undefined> => {
  const ledger = ports.getLedger();
  let committed: SessionPlan | undefined;
  if (plan && ledger?.taskId === taskId) {
    const task = plan.tasks.find((candidate) => candidate.id === taskId);
    if (task) {
      task.evidence = taskEvidenceFromLedger(ledger);
      committed = await ports.persistTaskEvidence(task.id, task.evidence);
    }
  }
  ports.setLedger(null);
  return committed;
};

export const applyTaskUpdateLedgerTransition = async (
  ports: PlanToolLedgerPorts,
  call: ToolCall,
  plan: SessionPlan | undefined,
): Promise<SessionPlan | undefined> => {
  const state = typeof call.args.state === "string" ? call.args.state : "";
  const requested =
    typeof call.args.taskId === "string"
      ? call.args.taskId
      : typeof call.args.id === "string"
        ? call.args.id
        : "";
  const taskId =
    (plan ? resolvePlanTaskId(plan, requested) : undefined) ?? requested;
  if (!taskId) return;
  if (state === "in_progress") {
    return openTaskLedger(ports, plan, taskId);
  }
  if (state === "done") {
    return completeTaskLedger(ports, plan, taskId);
  }
  if (state !== "failed" && state !== "skipped") return;
  if (ports.getLedger()?.taskId === taskId) ports.setLedger(null);
};
