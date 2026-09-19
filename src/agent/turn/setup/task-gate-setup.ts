import type { TaskEvidence } from "../../../store/plan.js";
import type { PlanMutator } from "../plan-persistence.js";
import {
  persistProjectRootOnPlan,
  persistTaskEvidence as persistPlanTaskEvidence,
} from "../plan-persistence.js";

export interface TaskGateSetup {
  readonly persistProjectRootOnPlan: (root: string) => Promise<void>;
  readonly persistTaskEvidence: (
    taskId: string,
    evidence: TaskEvidence,
  ) => Promise<void>;
}

export const setUpTaskGate = (input: {
  readonly mutatePlan: PlanMutator;
}): TaskGateSetup => ({
  persistProjectRootOnPlan: (root) =>
    persistProjectRootOnPlan(input.mutatePlan, root),
  persistTaskEvidence: (taskId, evidence) =>
    persistPlanTaskEvidence(input.mutatePlan, taskId, evidence),
});