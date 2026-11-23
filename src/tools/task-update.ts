import type { TaskState } from "../store/plan.js";

export const TASK_UPDATE_STATES: readonly TaskState[] = ["pending", "in_progress", "done", "failed", "skipped"];
export const TASK_UPDATE_LIMIT = 100;

export interface TaskStateChange {
  readonly taskId: string;
  readonly state: TaskState;
  readonly note: string | undefined;
}

function isTaskState(value: unknown): value is TaskState {
  return TASK_UPDATE_STATES.some((state) => state === value);
}

function parseGroup(
  { state, note }: Record<string, unknown>,
  taskIds: unknown,
  idKey: string,
): TaskStateChange[] | string {
  if (!isTaskState(state)) return `state must be one of ${TASK_UPDATE_STATES.join(", ")}.`;
  if (note !== undefined && typeof note !== "string") return "note must be a string.";
  if (!Array.isArray(taskIds) || taskIds.length < 1 || taskIds.length > TASK_UPDATE_LIMIT) {
    return `${idKey} must specify 1–${TASK_UPDATE_LIMIT} task ids.`;
  }
  const changes: TaskStateChange[] = [];
  for (const id of taskIds as unknown[]) {
    const taskId = typeof id === "string" ? id.trim() : "";
    if (!taskId) return `${idKey} must contain only non-empty task ids.`;
    changes.push({ taskId, state, note });
  }
  return changes;
}

function parseBatchGroup(group: unknown): TaskStateChange[] | string {
  if (!group || typeof group !== "object" || Array.isArray(group)) return "must be an object.";
  const entry = group as Record<string, unknown>;
  if (Object.keys(entry).some((key) => !["state", "taskIds", "note"].includes(key))) {
    return "accepts only state, taskIds and optional note.";
  }
  return parseGroup(entry, entry.taskIds, "taskIds");
}

function parseBatch(updates: unknown): TaskStateChange[] | string {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > TASK_UPDATE_LIMIT) {
    return `updates must be a non-empty array of at most ${TASK_UPDATE_LIMIT} groups.`;
  }
  const changes: TaskStateChange[] = [];
  for (const [index, group] of (updates as unknown[]).entries()) {
    const parsed = parseBatchGroup(group);
    if (typeof parsed === "string") return `updates[${index}]: ${parsed}`;
    if (changes.length + parsed.length > TASK_UPDATE_LIMIT) return `update at most ${TASK_UPDATE_LIMIT} tasks per call.`;
    changes.push(...parsed);
  }
  return changes;
}

export function parseTaskUpdate(args: Record<string, unknown>): TaskStateChange[] | string {
  if (!Object.hasOwn(args, "updates")) {
    const id = typeof args.taskId === "string" ? args.taskId : args.id;
    return parseGroup(args, [id], "taskId");
  }
  if (["taskId", "id", "state", "note"].some((key) => Object.hasOwn(args, key))) {
    return "pass either updates or taskId/state/note, not both.";
  }
  return parseBatch(args.updates);
}
