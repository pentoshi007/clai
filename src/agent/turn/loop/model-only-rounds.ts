import type { ChatMessage, ProviderId } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import { foregroundRemaining } from "../../../store/plan.js";
import { markDegradedToolModel } from "../../../llm/tool-protocol.js";

export interface ModelOnlyRoundPorts {
  readonly messages: ChatMessage[];
  readonly provider: ProviderId;
  readonly model: string;
  readonly toolsAttached: boolean;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly commitAssistantRetry: (text: string) => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly writeAssistantMessage: (text: string) => void;
  readonly unreadResponderIds: () => readonly string[];
}

export interface ModelOnlyRoundInput {
  readonly assistantVisible: string;
  readonly wantsAction: boolean;
  readonly narratedNextStep: boolean;
  readonly continuationEligible: boolean;
  readonly continuationChecked: boolean;
  readonly consecutiveModelOnlyRounds: number;
  readonly plan: SessionPlan | undefined;
}

export interface ModelOnlyStop {
  readonly kind: "stop";
  readonly answer: string;
  readonly remainingCriteria: string[];
  readonly reason: string;
}

export type ModelOnlyRoundDecision =
  | { readonly kind: "proceed" }
  | { readonly kind: "continue-round" }
  | { readonly kind: "continuation-check" }
  | ModelOnlyStop;

const STALLED_MESSAGE =
  "Stopped a repeated model-only retry cycle after the model returned no executable tool call. Completed work and transcript output were preserved.";

const NATIVE_FALLBACK_NUDGE =
  "Native tool calling did not produce an executable call. Continue now with exactly one complete fenced ```tool block. Do not repeat the prior narration.";

const stallRemainingCriteria = (
  plan: SessionPlan | undefined,
  hasUnreadResponders: boolean,
): string[] => {
  const criteria = plan
    ? foregroundRemaining(plan).map((task) => `[${task.id}] ${task.title}`)
    : [];
  if (hasUnreadResponders) {
    criteria.push("Analyze and acknowledge each delivered Responder result.");
  }
  if (criteria.length === 0) {
    criteria.push("Continue the unfinished work with an executable tool call.");
  }
  return criteria;
};

const unreadResponderNudge = (unread: readonly string[]): string =>
  `You have ${unread.length} delivered Responder result(s) that remain unread: ${unread.join(", ")}. ` +
  "If analysis is incomplete, call only the bounded evidence tool needed now. If each result has been analyzed and is satisfactory, you MUST call job.read with its jobId or exact notificationId before giving a final response. job.read does not require an active plan; do not create or update a plan merely to acknowledge a result.";

const EXECUTING_PLAN_STATUSES: ReadonlySet<SessionPlan["status"]> = new Set([
  "approved",
  "in_progress",
]);

const openPlanTasks = (plan: SessionPlan | undefined): string[] =>
  plan && EXECUTING_PLAN_STATUSES.has(plan.status)
    ? foregroundRemaining(plan).map((task) => `[${task.id}] ${task.title}`)
    : [];

const continuationCheckMessage = (openTasks: readonly string[]): string => {
  const evidence =
    openTasks.length > 0
      ? `Your previous reply ended the turn without a tool call while the active plan still has open tasks:\n${openTasks.map((task) => `- ${task}`).join("\n")}`
      : "Your previous reply described a next step but ended the turn without a tool call.";
  return (
    `CONTINUATION CHECK: ${evidence}\n` +
    "If you meant to keep working on the user's current request, make the next tool call now without repeating your previous reply. " +
    "If the work is complete, you are blocked, you need the user's input or confirmation, or the user's latest instructions say to pause or stop here, " +
    "reply with your final message and no tool call; that reply ends the turn."
  );
};

export const handleModelOnlyRound = (
  ports: ModelOnlyRoundPorts,
  input: ModelOnlyRoundInput,
): ModelOnlyRoundDecision => {
  const unread = ports.unreadResponderIds();
  const hasUnread = unread.length > 0;
  if (input.continuationChecked && !hasUnread) return { kind: "proceed" };
  const actionable = input.wantsAction || hasUnread;

  if (
    actionable &&
    ports.toolsAttached &&
    input.consecutiveModelOnlyRounds === 2
  ) {
    markDegradedToolModel(ports.provider, ports.model);
    ports.commitAssistantRetry(input.assistantVisible);
    ports.notify(
      "warn",
      "model repeatedly returned prose instead of a native tool call — switching this model to the text tool protocol for the rest of this turn",
    );
    ports.messages.push(ports.recoveryUserMessage(NATIVE_FALLBACK_NUDGE));
    return { kind: "continue-round" };
  }

  if (actionable && input.consecutiveModelOnlyRounds >= 6) {
    ports.commitAssistantRetry(input.assistantVisible);
    ports.writeAssistantMessage(STALLED_MESSAGE);
    return {
      kind: "stop",
      answer: STALLED_MESSAGE,
      remainingCriteria: stallRemainingCriteria(input.plan, hasUnread),
      reason:
        "The model returned six consecutive responses without executing a tool.",
    };
  }

  if (hasUnread) {
    ports.commitAssistantRetry(input.assistantVisible);
    ports.messages.push(ports.recoveryUserMessage(unreadResponderNudge(unread)));
    return { kind: "continue-round" };
  }

  if (ports.toolsAttached && input.continuationEligible) {
    const openTasks = openPlanTasks(input.plan);
    if (openTasks.length > 0 || input.narratedNextStep) {
      ports.commitAssistantRetry(input.assistantVisible);
      ports.notify(
        "info",
        "reply ended without a tool call while work looks unfinished — asking the model to continue or confirm it is done",
      );
      ports.messages.push(
        ports.recoveryUserMessage(continuationCheckMessage(openTasks)),
      );
      return { kind: "continuation-check" };
    }
  }

  return { kind: "proceed" };
};
