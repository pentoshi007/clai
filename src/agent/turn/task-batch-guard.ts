import type { ToolCall } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import { resolvePlanTaskId } from "../plan-tool.js";
import {
  batchUpdateSignature,
  buildMultiOpenRejection,
  buildMultiUpdateReminder,
  distinctAdvancingTaskIds,
  isSimultaneousTaskAdvance,
  multiOpenToast,
  multiUpdateToast,
  openingTaskIds,
  readTaskUpdateArgs,
  type BatchTaskDescriptor,
  type TaskUpdateIntent,
} from "../task-sync.js";

export interface TaskBatchGuardInput {
  readonly calls: readonly ToolCall[];
  readonly plan: SessionPlan | undefined;
  readonly pendingSignature: string | undefined;
}

export interface TaskBatchNotice {
  readonly level: "info" | "warn";
  readonly message: string;
}

export interface TaskBatchGuardOutcome {
  readonly remindCalls: ReadonlySet<ToolCall>;
  readonly reminderNote: string;
  readonly pendingSignature: string | undefined;
  readonly notices: readonly TaskBatchNotice[];
}

const readIntents = (
  input: TaskBatchGuardInput,
): readonly TaskUpdateIntent[] => {
  const intents: TaskUpdateIntent[] = [];
  for (const call of input.calls) {
    const parsed = readTaskUpdateArgs(call);
    if (!parsed) continue;
    const taskId = input.plan
      ? (resolvePlanTaskId(input.plan, parsed.taskId) ?? parsed.taskId)
      : parsed.taskId;
    intents.push({ call, taskId, state: parsed.state });
  }
  return intents;
};

const titleFor = (plan: SessionPlan | undefined, taskId: string): string =>
  plan?.tasks.find((task) => task.id === taskId)?.title ?? "";

const rejectMultiOpen = (
  input: TaskBatchGuardInput,
  intents: readonly TaskUpdateIntent[],
  openIds: readonly string[],
): TaskBatchGuardOutcome => {
  const descriptors: BatchTaskDescriptor[] = openIds.map((taskId) => ({
    taskId,
    title: titleFor(input.plan, taskId),
    targetState: "in_progress",
  }));
  const remindCalls = new Set<ToolCall>();
  for (const intent of intents) {
    if (intent.state === "in_progress") remindCalls.add(intent.call);
  }
  return {
    remindCalls,
    reminderNote: buildMultiOpenRejection(descriptors),
    pendingSignature: undefined,
    notices: [{ level: "warn", message: multiOpenToast(openIds.length) }],
  };
};

const holdSimultaneousAdvance = (
  input: TaskBatchGuardInput,
  intents: readonly TaskUpdateIntent[],
): TaskBatchGuardOutcome => {
  const descriptors: BatchTaskDescriptor[] = intents.map((intent) => ({
    taskId: intent.taskId,
    title: titleFor(input.plan, intent.taskId),
    targetState: intent.state,
  }));
  const remindCalls = new Set<ToolCall>();
  for (const intent of intents) remindCalls.add(intent.call);
  return {
    remindCalls,
    reminderNote: buildMultiUpdateReminder(descriptors),
    pendingSignature: batchUpdateSignature(intents),
    notices: [
      {
        level: "warn",
        message: multiUpdateToast(distinctAdvancingTaskIds(intents).length),
      },
    ],
  };
};

export const evaluateTaskBatchGuard = (
  input: TaskBatchGuardInput,
): TaskBatchGuardOutcome => {
  const intents = readIntents(input);
  const openIds = openingTaskIds(intents);
  if (openIds.length > 1) {
    return rejectMultiOpen(input, intents, openIds);
  }
  if (!isSimultaneousTaskAdvance(intents)) {
    return {
      remindCalls: new Set<ToolCall>(),
      reminderNote: "",
      pendingSignature: undefined,
      notices: [],
    };
  }
  const signature = batchUpdateSignature(intents);
  if (input.pendingSignature === signature) {
    return {
      remindCalls: new Set<ToolCall>(),
      reminderNote: "",
      pendingSignature: undefined,
      notices: [
        { level: "info", message: "confirmed batch task update — applying" },
      ],
    };
  }
  return holdSimultaneousAdvance(input, intents);
};
