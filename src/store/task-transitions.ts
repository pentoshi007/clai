/** Structural mirror of `TaskState` in the plan store; kept here to avoid a cycle. */
export type TaskState =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

// The set of task-state transitions an ordinary update may perform.
// `done` and `skipped` are terminal: regressing them re-executes finished work
// and re-blocks dependents. Reopening after a failure is an explicit retry.
// A plan revision (task.add / plan.revise) supersedes a task instead of
// rewinding it, so revisions bypass this table by design.

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

/** True when no ordinary `task.update` may move the task any further. */
export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * Decide whether `task.update` may move a task from `from` to `to`.
 * Re-asserting the current state is always allowed so idempotent retries and
 * note-only updates keep working.
 */
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
