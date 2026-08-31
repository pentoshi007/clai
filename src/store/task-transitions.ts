export type TaskState =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";


export type TaskTransitionDenialCode =
  | "terminal"
  | "retry-required"
  | "unsupported";

export interface TaskTransitionDenied {
  readonly allowed: false;
  readonly code: TaskTransitionDenialCode;
  readonly reason: string;
}

export type TaskTransitionResult = { readonly allowed: true } | TaskTransitionDenied;

const ALLOWED: Readonly<Record<TaskState, readonly TaskState[]>> = {
  pending: ["in_progress", "done", "failed", "skipped"],
  in_progress: ["pending", "done", "failed", "skipped"],
  failed: ["in_progress", "skipped"],
  done: [],
  skipped: [],
};

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "done",
  "skipped",
]);

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function evaluateTaskTransition(
  from: TaskState,
  to: TaskState,
): TaskTransitionResult {
  if (from === to) return { allowed: true };
  if ((ALLOWED[from] ?? []).includes(to)) return { allowed: true };
  if (TERMINAL_STATES.has(from)) {
    return {
      allowed: false,
      code: "terminal",
      reason: `already ${from} — completed work is not reopened by task.update; add a follow-up task instead`,
    };
  }
  if (from === "failed" && to === "done") {
    return {
      allowed: false,
      code: "retry-required",
      reason:
        "is failed — reopen it with state:\"in_progress\" and redo the work before marking it done",
    };
  }
  return {
    allowed: false,
    code: "unsupported",
    reason: `cannot move from ${from} to ${to}`,
  };
}
