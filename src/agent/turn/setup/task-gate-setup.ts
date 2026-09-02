import type { SessionPlan, TaskEvidence } from "../../../store/plan.js";
import type { TaskWorkLedger } from "../../task-evidence.js";
import type { ToolExecutionState } from "../tool-execution/state.js";
import type { LooseWorkReceipt } from "../../task-evidence.js";
import type { PlanMutator } from "../plan-persistence.js";
import {
  evaluateTaskCompletionGate,
  resolveLedgerForTaskGate,
} from "../task-gate.js";
import type { canMarkTaskDone } from "../../task-evidence.js";
import {
  persistProjectRootOnPlan,
  persistTaskEvidence as persistPlanTaskEvidence,
} from "../plan-persistence.js";
import { scaffoldLooksMaterialized } from "../../workspace-orient.js";

export interface TaskGateSetup {
  readonly ledgerForTask: (
    plan: SessionPlan,
    taskId: string,
  ) => TaskWorkLedger | null;
  readonly completionGateForTask: (
    plan: SessionPlan,
    taskId: string,
  ) => ReturnType<typeof canMarkTaskDone>;
  readonly persistProjectRootOnPlan: (root: string) => Promise<void>;
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<void>;
}

export const setUpTaskGate = (input: {
  readonly toolState: ToolExecutionState;
  readonly looseWork: LooseWorkReceipt[];
  readonly featureAppRequired: boolean;
  readonly projectRoot: () => string | undefined;
  readonly mutatePlan: PlanMutator;
}): TaskGateSetup => {
  const ports = {
    getLiveLedger: () => input.toolState.taskWorkLedger,
    setLiveLedger: (ledger: TaskWorkLedger) => {
      input.toolState.taskWorkLedger = ledger;
    },
    getLooseWork: () => input.looseWork,
    featureAppRequired: input.featureAppRequired,
    existingProject: () => scaffoldLooksMaterialized(input.projectRoot()),
  };
  return {
    ledgerForTask: (plan, taskId) =>
      resolveLedgerForTaskGate(ports, plan, taskId),
    completionGateForTask: (plan, taskId) =>
      evaluateTaskCompletionGate(ports, plan, taskId),
    persistProjectRootOnPlan: (root) =>
      persistProjectRootOnPlan(input.mutatePlan, root),
    persistTaskEvidence: (taskId, evidence) =>
      persistPlanTaskEvidence(input.mutatePlan, taskId, evidence),
  };
};
