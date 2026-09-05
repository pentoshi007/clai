import type { ChatMessage, ProviderId, TokenUsage } from "../../../types.js";
import type { StreamRecoveryState } from "../../stream-recovery.js";
import {
  classifyStreamFailure,
  planStreamRecovery,
  recordRecoveryAttempt,
} from "../../stream-recovery.js";
import {
  appendInterruptedReasoning,
  interruptedReasoningBrief,
  isMeaningfulResumptionYield,
} from "../../interrupted-reasoning.js";
import { freeTierGuardNotices } from "../../reliability-policy.js";
import { collapseRepeatedText, textBeforeToolCall } from "../../tool-call-parser.js";
import { stripThinking } from "../../../ui/thinking.js";
import { trimExactContinuationOverlap } from "../continuation-overlap.js";

export interface StreamFailureDeferredCall {
  readonly eventId: string;
  readonly call: { readonly name: string };
  readonly shown: boolean;
}

export interface StreamFailureState {
  freeTierConsecutiveFailures: number;
  freeTierAdvisoryShown: boolean;
  lowYieldResumptions: number;
  interruptedVisible: string;
  interruptedReasoning: string;
  allowModelFallback: boolean;
  preferModelFallback: boolean;
  retryWithoutThinking: boolean;
  visibleCommitted: boolean;
}

export interface StreamFailurePorts {
  readonly messages: ChatMessage[];
  readonly recoveryState: StreamRecoveryState;
  readonly provider: ProviderId;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly emitStatus: (text: string) => void;
  readonly emitTokenUsage: (
    usage: TokenUsage,
    provider: ProviderId,
    model: string,
  ) => void;
  readonly emitEmptyAssistantMessage: () => void;
  readonly writeAssistantMessage: (text: string) => void;
  readonly writeThinkingBlock: (text: string) => void;
  readonly writeToolBlocked: (
    eventId: string,
    toolName: string,
    reason: string,
  ) => void;
  readonly rememberThinking: (text: string) => void;
  readonly sanitizeAssistantText: (text: string) => string;
  readonly finishDeltaParser: () => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly forceCompact: (reason: string) => Promise<void>;
  readonly delay: (ms: number) => Promise<void>;
}

export interface StreamFailureAttemptUsage {
  readonly usage: TokenUsage;
  readonly provider: ProviderId;
  readonly model: string;
}

export interface StreamFailureInput {
  readonly kind: ReturnType<typeof classifyStreamFailure>;
  readonly error?: unknown;
  readonly alreadyEmitted: boolean;
  readonly attemptUsage: StreamFailureAttemptUsage | undefined;
  readonly accumulatedText: string;
  readonly streamedReasoningText: string;
  readonly deferredToolCalls: readonly StreamFailureDeferredCall[];
}

export type StreamFailureDecision = "retry" | "rethrow";

interface PartialStream {
  readonly present: boolean;
  readonly visible: string;
  readonly normalizedVisible: string;
  readonly thinkContent: string;
  readonly hasThinking: boolean;
}

const INTERRUPTED_WITH_OUTPUT =
  "The provider stream was interrupted after partial output. Continue from the exact stopping point without repeating prior text. Any incomplete tool call was discarded and must be reissued in full.";

const INTERRUPTED_WITHOUT_OUTPUT =
  "The provider stream was interrupted before any answer was produced. Any incomplete tool call was discarded and must be reissued in full. Do not restart your analysis from the beginning.";

const DISCARDED_TOOL_CALL =
  "Incomplete tool call discarded after the provider stream was interrupted.";

const showFreeTierAdvisories = (
  ports: StreamFailurePorts,
  state: StreamFailureState,
): void => {
  if (state.freeTierAdvisoryShown) return;
  for (const notice of freeTierGuardNotices({
    provider: ports.provider,
    consecutiveFailures: state.freeTierConsecutiveFailures,
  })) {
    ports.notify("warn", notice);
    state.freeTierAdvisoryShown = true;
  }
};

const readPartialStream = (
  ports: StreamFailurePorts,
  state: StreamFailureState,
  input: StreamFailureInput,
): PartialStream => {
  const present = input.alreadyEmitted || input.accumulatedText.length > 0;
  const split = stripThinking(input.accumulatedText);
  const thinkContent = [
    input.streamedReasoningText.trim(),
    split.thinkContent,
  ]
    .filter(Boolean)
    .join("\n\n");
  if (thinkContent) ports.rememberThinking(thinkContent);
  const rawVisible = present
    ? textBeforeToolCall(
        stripThinking(collapseRepeatedText(input.accumulatedText)).visible,
      )
    : "";
  const normalizedVisible = trimExactContinuationOverlap(
    state.interruptedVisible,
    rawVisible,
  );
  return {
    present,
    visible: normalizedVisible.trim(),
    normalizedVisible,
    thinkContent,
    hasThinking: thinkContent.length > 0,
  };
};

const restartNoticeFor = (
  state: StreamFailureState,
  terminalFailure: boolean,
): string => {
  if (terminalFailure) {
    return "partial response preserved before terminal provider failure";
  }
  if (state.lowYieldResumptions > 1) {
    return `route is dropping after almost no output (${state.lowYieldResumptions} in a row) — switching model`;
  }
  return "partial response preserved — resuming from the interruption";
};

const commitPartialOutput = (
  ports: StreamFailurePorts,
  state: StreamFailureState,
  input: StreamFailureInput,
  partial: PartialStream,
  terminalFailure: boolean,
): string => {
  ports.finishDeltaParser();
  const hasShownToolCall = input.deferredToolCalls.some((entry) => entry.shown);
  if (partial.visible) {
    if (terminalFailure) {
      ports.writeAssistantMessage(
        state.interruptedVisible + partial.normalizedVisible,
      );
    } else {
      state.visibleCommitted = true;
    }
    ports.messages.push({
      role: "assistant",
      content: ports.sanitizeAssistantText(partial.visible),
    });
    state.interruptedVisible += partial.normalizedVisible;
  } else if (terminalFailure) {
    ports.emitEmptyAssistantMessage();
  }
  if (partial.hasThinking && !hasShownToolCall) {
    ports.writeThinkingBlock(partial.thinkContent);
  }
  if (partial.hasThinking) {
    state.interruptedReasoning = appendInterruptedReasoning(
      state.interruptedReasoning,
      partial.thinkContent,
    );
  }
  for (const deferred of input.deferredToolCalls) {
    if (!deferred.shown || deferred.call.name === "…") continue;
    ports.writeToolBlocked(
      deferred.eventId,
      deferred.call.name,
      DISCARDED_TOOL_CALL,
    );
  }
  const nudge = [
    partial.visible ? INTERRUPTED_WITH_OUTPUT : INTERRUPTED_WITHOUT_OUTPUT,
    interruptedReasoningBrief(state.interruptedReasoning),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  ports.notify("warn", restartNoticeFor(state, terminalFailure));
  return nudge;
};

export const recoverFromStreamFailure = async (
  ports: StreamFailurePorts,
  state: StreamFailureState,
  input: StreamFailureInput,
): Promise<StreamFailureDecision> => {
  state.freeTierConsecutiveFailures += 1;
  showFreeTierAdvisories(ports, state);

  const failureKind = input.kind;
  if (input.attemptUsage) {
    ports.emitTokenUsage(
      input.attemptUsage.usage,
      input.attemptUsage.provider,
      input.attemptUsage.model,
    );
  }
  const partial = readPartialStream(ports, state, input);
  const meaningfulProgress =
    partial.present &&
    isMeaningfulResumptionYield(
      partial.normalizedVisible.length + partial.thinkContent.length,
    );
  if (partial.present) {
    state.lowYieldResumptions = meaningfulProgress
      ? 0
      : state.lowYieldResumptions + 1;
  }
  const plan = planStreamRecovery({
    kind: failureKind,
    ...(input.error !== undefined ? { error: input.error } : {}),
    state: ports.recoveryState,
    progressed: meaningfulProgress,
  });
  const terminalFailure = plan.action === "give-up";

  const continuationNudge = partial.present
    ? commitPartialOutput(ports, state, input, partial, terminalFailure)
    : "";

  if (terminalFailure) return "rethrow";

  recordRecoveryAttempt(ports.recoveryState, failureKind, meaningfulProgress);
  if (state.lowYieldResumptions > 1) {
    state.allowModelFallback = true;
    state.preferModelFallback = true;
  }
  if (plan.notice) ports.notify("warn", plan.notice);
  if (plan.disableThinking) state.retryWithoutThinking = true;
  if (plan.allowModelFallback) state.allowModelFallback = true;
  if (plan.preferModelFallback) state.preferModelFallback = true;
  if (plan.forceCompact) {
    await ports.forceCompact(`stream-recovery:${failureKind}`);
  }
  const recoveryNudge = [continuationNudge, plan.nudge]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  if (recoveryNudge) {
    ports.messages.push(ports.recoveryUserMessage(recoveryNudge));
  }
  if (plan.delayMs > 0) {
    ports.emitStatus(
      `retrying in ${Math.ceil(plan.delayMs / 1000)}s (${failureKind})`,
    );
    await ports.delay(plan.delayMs);
  }
  return "retry";
};
