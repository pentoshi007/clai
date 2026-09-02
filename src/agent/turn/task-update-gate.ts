import type { SessionPlan } from "../../store/plan.js";

export interface TaskUpdateRequest {
  readonly state: string;
  readonly taskId: string;
}

export type TaskUpdateGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export const parseTaskUpdateRequest = (
  args: Record<string, unknown>,
): TaskUpdateRequest => ({
  state: typeof args.state === "string" ? args.state : "",
  taskId:
    typeof args.taskId === "string"
      ? args.taskId
      : typeof args.id === "string"
        ? args.id
        : "",
});

const dependenciesIncomplete = (
  plan: SessionPlan,
  taskId: string,
): boolean => {
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  return (
    task?.dependencies?.some((dependency) => {
      const dependencyTask = plan.tasks.find(
        (candidate) => candidate.id === dependency,
      );
      return (
        !dependencyTask ||
        (dependencyTask.state !== "done" && dependencyTask.state !== "skipped")
      );
    }) ?? false
  );
};

export const decideTaskUpdateDoneGate = (
  plan: SessionPlan | undefined,
  taskId: string,
  completionGate: (plan: SessionPlan, taskId: string) => TaskUpdateGateResult,
): TaskUpdateGateResult => {
  if (!plan) {
    return {
      ok: false,
      reason: `Task ${taskId} cannot be marked done because its active plan is unavailable.`,
    };
  }
  const target = plan.tasks.find((candidate) => candidate.id === taskId);
  const canSoftComplete =
    target?.state === "pending" && !dependenciesIncomplete(plan, taskId);
  if (target?.state === "in_progress" || canSoftComplete) {
    return completionGate(plan, taskId);
  }
  if (target?.state === "failed") {
    return {
      ok: false,
      reason: `Task ${taskId} is failed — retry with in_progress first, then mark done after recovery work.`,
    };
  }
  return {
    ok: false,
    reason: `Task ${taskId} must be in_progress before it can be marked done. Start or retry the task, perform fresh work, then complete it.`,
  };
};
