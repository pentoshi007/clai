import type { GovernorState } from "../../evidence-governor.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { TaskWorkLedger } from "../../task-evidence.js";

export interface ToolExecutionState {
  narrowNmapDispatchCount: number;
  pendingSessionStatePlan: SessionPlan | null | undefined;
  taskWorkLedger: TaskWorkLedger | null;
  dispatchedTaskId: string | undefined;
  delegation: { id: string; taskId?: string } | undefined;
  retryDependenciesChanged: boolean;
  retryEnvironmentChanged: boolean;
  governorState: GovernorState;
  governorReflects: number;
  lastGovernorReason: string | undefined;
}

export const createToolExecutionState = (
  activePlan: SessionPlan | null | undefined,
  governorState: GovernorState,
): ToolExecutionState => ({
  narrowNmapDispatchCount: 0,
  pendingSessionStatePlan: activePlan,
  taskWorkLedger: null,
  dispatchedTaskId: undefined,
  delegation: undefined,
  retryDependenciesChanged: false,
  retryEnvironmentChanged: false,
  governorState,
  governorReflects: 0,
  lastGovernorReason: undefined,
});
