import type { ToolCall } from "../types.js";


export type TaskUpdateState =
  | "pending"
  | "in_progress"
  | "done"
  | "failed"
  | "skipped";

export interface TaskUpdateIntent {
  readonly call: ToolCall;
  readonly taskId: string;
  readonly state: string;
}

export interface BatchTaskDescriptor {
  readonly taskId: string;
  readonly title: string;
  readonly targetState: string;
}

export interface DependencyReminderInput {
  readonly taskId: string;
  readonly title: string;
  readonly targetState: string;
  readonly blockers: readonly { readonly id: string; readonly title: string }[];
}

const ADVANCING_STATES: ReadonlySet<string> = new Set(["done", "in_progress"]);

const MAX_LISTED_TASKS = 12;

export function readTaskUpdateArgs(
  call: ToolCall,
): { taskId: string; state: string } | undefined {
  if (call.name !== "task.update") return undefined;
  const args = call.args ?? {};
  const taskId =
    typeof args.taskId === "string"
      ? args.taskId.trim()
      : typeof args.id === "string"
        ? args.id.trim()
        : "";
  const state = typeof args.state === "string" ? args.state.trim() : "";
  if (!taskId || !state) return undefined;
  return { taskId, state };
}

export function distinctAdvancingTaskIds(
  intents: readonly TaskUpdateIntent[],
): string[] {
  const ids = new Set<string>();
  for (const intent of intents) {
    if (ADVANCING_STATES.has(intent.state)) ids.add(intent.taskId);
  }
  return [...ids];
}

export function advancingStateCounts(
  intents: readonly TaskUpdateIntent[],
): { done: number; inProgress: number } {
  const done = new Set<string>();
  const inProgress = new Set<string>();
  for (const intent of intents) {
    if (intent.state === "done") done.add(intent.taskId);
    else if (intent.state === "in_progress") inProgress.add(intent.taskId);
  }
  return { done: done.size, inProgress: inProgress.size };
}

export function isSimultaneousTaskAdvance(
  intents: readonly TaskUpdateIntent[],
): boolean {
  const { done, inProgress } = advancingStateCounts(intents);
  return done > 1 || inProgress > 1;
}

export function batchUpdateSignature(
  intents: readonly TaskUpdateIntent[],
): string {
  const parts = intents
    .map((intent) => `${intent.taskId}:${intent.state}`)
    .sort();
  return `batch:${parts.join("|")}`;
}

export function dependencySignature(
  taskId: string,
  state: string,
  blockerIds: readonly string[],
): string {
  return `dep:${taskId}:${state}:${[...blockerIds].sort().join(",")}`;
}

function formatTaskLine(descriptor: BatchTaskDescriptor, index: number): string {
  const title = descriptor.title.trim() || "(untitled task)";
  return `  ${index + 1}. [${descriptor.taskId}] ${title} → ${descriptor.targetState}`;
}

export function buildMultiUpdateReminder(
  descriptors: readonly BatchTaskDescriptor[],
): string {
  const shown = descriptors.slice(0, MAX_LISTED_TASKS);
  const extra = descriptors.length - shown.length;
  const list = shown.map(formatTaskLine).join("\n");
  const overflow = extra > 0 ? `\n  …and ${extra} more` : "";
  return (
    `HELD — one message advances several tasks at once:\n` +
    `${list}${overflow}\n\n` +
    "Nothing was changed. Closing one task and opening the next in the same message is fine — " +
    "this hold only fires when you complete several tasks at once or start several at once. " +
    "That is only valid when EVERY one is truly finished (or truly started) and you have already read the tool results proving it. " +
    "If you are certain all of these are complete and verified, re-issue these exact task.update calls again to CONFIRM and they will be applied. " +
    "If even one is not done, do NOT batch: work in sync — set one task in_progress, do its work, read and verify the results, mark it done, then open the next. One task at a time."
  );
}

export function buildDependencyReminder(input: DependencyReminderInput): string {
  const title = input.title.trim() || "(untitled task)";
  const blockers = input.blockers
    .map((blocker) => `[${blocker.id}] ${blocker.title.trim() || "(untitled)"}`)
    .join(", ");
  return (
    `WARNING — [${input.taskId}] "${title}" is now ${input.targetState} while ` +
    `these prerequisite task(s) remain open: ${blockers}. ` +
    "The transition was applied; this is not a block. Continue deliberately only if the earlier task is effectively satisfied, was left unmarked, or the work is intentionally out of order. " +
    "Otherwise return to the prerequisite before claiming this task complete. Completion still requires all declared dependencies to be done or skipped."
  );
}

export function openingTaskIds(
  intents: readonly TaskUpdateIntent[],
): string[] {
  const ids = new Set<string>();
  for (const intent of intents) {
    if (intent.state === "in_progress") ids.add(intent.taskId);
  }
  return [...ids];
}

export function buildMultiOpenRejection(
  descriptors: readonly BatchTaskDescriptor[],
): string {
  const shown = descriptors.slice(0, MAX_LISTED_TASKS);
  const extra = descriptors.length - shown.length;
  const list = shown.map(formatTaskLine).join("\n");
  const overflow = extra > 0 ? `\n  …and ${extra} more` : "";
  const first = descriptors[0];
  return (
    `REJECTED — one message tries to start several tasks at once:\n` +
    `${list}${overflow}\n\n` +
    "Nothing was changed. Exactly one foreground task may be in_progress at a time; this is enforced by the task store, not a convention, so re-issuing these calls will not apply them. " +
    (first ? `Open only [${first.taskId}] now, finish and verify it, mark it done, then open the next one. ` : "") +
    "Responder-owned background subtasks are exempt and advance on their own."
  );
}

export function multiOpenToast(count: number): string {
  return `${count} tasks opened at once · rejected, one active task only`;
}

export function multiUpdateToast(count: number): string {
  return `${count} task updates batched · verify & sync one by one`;
}

export function dependencyToast(taskId: string): string {
  return `[${taskId}] opened with prerequisites still pending`;
}
