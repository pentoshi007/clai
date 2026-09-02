import { randomUUID } from "node:crypto";
import type { ToolCall } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import { appendPlanTask, readyPlanTasks } from "../../../store/plan.js";
import {
  ledgerFromTaskEvidence,
  pickPendingTaskForToolCall,
  type TaskWorkLedger,
} from "../../task-evidence.js";
import {
  delegationTaskTitle,
  isExplicitResponderDelegation,
  readDeclaredParentTaskId,
  resolveResponderParent,
} from "../../responder-parent.js";

export interface ToolDispatchDelegation {
  id: string;
  taskId?: string;
}

export interface ToolDispatchPorts {
  readonly mutatePlan: (
    mutator: (draft: SessionPlan) => boolean,
  ) => Promise<{ ok: boolean; plan?: SessionPlan | undefined } | undefined>;
  readonly renderPlan: (plan: SessionPlan) => void;
  readonly setPendingSessionStatePlan: (plan: SessionPlan) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly getLedger: () => TaskWorkLedger | null;
  readonly setLedger: (ledger: TaskWorkLedger | null) => void;
}

export type ToolDispatchOutcome =
  | {
      readonly kind: "dispatch";
      readonly dispatchedTaskId: string | undefined;
      readonly delegation: ToolDispatchDelegation | undefined;
    }
  | { readonly kind: "reject"; readonly reason: string };

const inferDispatchedTaskId = (
  plan: SessionPlan | undefined,
  call: ToolCall,
): string | undefined => {
  const foreground = plan?.tasks.find(
    (task) => task.state === "in_progress" && !task.responderOwned,
  )?.id;
  if (foreground) return foreground;
  if (plan?.kind !== "pentest") return undefined;
  return pickPendingTaskForToolCall(
    readyPlanTasks(plan),
    call,
    plan.tasks.map((task) => task.title),
  )?.id;
};

const createDelegationChild = async (
  ports: ToolDispatchPorts,
  call: ToolCall,
  parentTaskId: string | undefined,
): Promise<ToolDispatchDelegation | undefined> => {
  const delegation: ToolDispatchDelegation = {
    id: `dg-${randomUUID().slice(0, 8)}`,
  };
  const created = await ports
    .mutatePlan((draft) => {
      const parentExists =
        !!parentTaskId && draft.tasks.some((task) => task.id === parentTaskId);
      const child = appendPlanTask(draft, {
        title: delegationTaskTitle(call),
        state: "in_progress",
        note: `delegation=${delegation.id} awaiting launch`,
        dependencies: [],
        resourceLocks: [],
        ...(parentExists ? { parentTaskId } : {}),
        responderOwned: true,
        delegationId: delegation.id,
      });
      delegation.taskId = child.id;
      return true;
    })
    .catch(() => undefined);

  if (!created?.ok || !delegation.taskId) {
    ports.notify(
      "warn",
      "Responder delegation record could not be persisted — the job will be linked after launch",
    );
    return undefined;
  }
  if (created.plan) {
    ports.setPendingSessionStatePlan(created.plan);
    ports.renderPlan(created.plan);
  }
  return delegation;
};

const adoptDispatchedLedger = (
  ports: ToolDispatchPorts,
  plan: SessionPlan | undefined,
  dispatchedTaskId: string,
): void => {
  const ledger = ports.getLedger();
  if (ledger && ledger.taskId === dispatchedTaskId) return;
  const dispatchedTask = plan?.tasks.find(
    (task) => task.id === dispatchedTaskId,
  );
  ports.setLedger(
    ledgerFromTaskEvidence(dispatchedTaskId, dispatchedTask?.evidence),
  );
};

export const resolveToolDispatch = async (
  ports: ToolDispatchPorts,
  call: ToolCall,
  plan: SessionPlan | undefined,
): Promise<ToolDispatchOutcome> => {
  let dispatchedTaskId = inferDispatchedTaskId(plan, call);

  const declaredParent = readDeclaredParentTaskId(call);
  if (declaredParent) {
    const resolvedParent = resolveResponderParent({
      plan,
      declared: declaredParent,
      activeForegroundTaskIds: dispatchedTaskId ? [dispatchedTaskId] : [],
    });
    if (!resolvedParent.ok) {
      return {
        kind: "reject",
        reason: `${call.name} failed: ${resolvedParent.reason}`,
      };
    }
    dispatchedTaskId = resolvedParent.taskId ?? dispatchedTaskId;
  }

  const delegation =
    isExplicitResponderDelegation(call) && plan
      ? await createDelegationChild(ports, call, dispatchedTaskId)
      : undefined;

  if (dispatchedTaskId) {
    adoptDispatchedLedger(ports, plan, dispatchedTaskId);
  }

  return { kind: "dispatch", dispatchedTaskId, delegation };
};
