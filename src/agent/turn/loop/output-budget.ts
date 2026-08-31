import type { ChatMessage, CompletionResult, ProviderId } from "../../../types.js";
import { resolveBuiltInProfile } from "../../../llm/provider-profiles.js";
import { outputBudgetWasExhausted } from "../../reliability-policy.js";
import {
  appendInterruptedReasoning,
  interruptedReasoningBrief,
} from "../../interrupted-reasoning.js";

export const MAX_OUTPUT_BUDGET_CONTINUATIONS = 1;

export interface OutputBudgetState {
  truncatedBudgetRounds: number;
  continuationBudgetFloor: number;
  retryWithoutThinking: boolean;
  interruptedVisible: string;
  interruptedReasoning: string;
  lowYieldResumptions: number;
  visibleCommitted: boolean;
}

export interface OutputBudgetPorts {
  readonly messages: ChatMessage[];
  readonly provider: ProviderId;
  readonly model: string;
  readonly stepMaxTokens: number;
  readonly maxStepCompletionTokens: number;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly recoveryUserMessage: (content: string) => ChatMessage;
  readonly pushAssistantHistory: (text: string) => void;
  readonly commitAssistantRetry: (text: string) => void;
}

export interface OutputBudgetInput {
  readonly completion: CompletionResult;
  readonly assistantVisible: string;
  readonly assistantThinkContent: string;
  readonly hasThinking: boolean;
  readonly canonicalVisible: string;
}

export type OutputBudgetDecision = "continue-round" | "stop-partial" | "proceed";

export const routeCompletionBudget = (input: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly stepMaxTokens: number;
}): number => {
  const limit = resolveBuiltInProfile({
    provider: input.provider,
    model: input.model,
  }).limits.outputTokens;
  return limit === undefined
    ? input.stepMaxTokens
    : Math.min(input.stepMaxTokens, limit);
};

export const outputBudgetExhausted = (input: {
  readonly completion: CompletionResult;
  readonly completionBudget: number;
}): boolean =>
  outputBudgetWasExhausted({
    finishReason: input.completion.finishReason,
    completionTokens: input.completion.usage?.completionTokens ?? 0,
    requestedMaxTokens: input.completionBudget,
  });

const continuationNudge = (
  hasVisible: boolean,
  retryWithoutThinking: boolean,
  reasoning: string,
): string =>
  [
    hasVisible
      ? "Your previous response was cut off by the output token limit. Continue from the exact stopping point without repeating any prior text."
      : "Your previous response spent the output budget before producing a visible answer. Do not restart the analysis; use the preserved conclusions and answer now.",
    retryWithoutThinking
      ? "Optional reasoning is disabled for this continuation. Emit the next tool call or final answer directly and briefly."
      : "Finish the reasoning briefly, then emit the next tool call or final answer directly.",
    interruptedReasoningBrief(reasoning),
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

const preserveAndContinue = (
  ports: OutputBudgetPorts,
  state: OutputBudgetState,
  input: OutputBudgetInput,
  completionBudget: number,
): OutputBudgetDecision => {
  const profile = resolveBuiltInProfile({
    provider: ports.provider,
    model: ports.model,
  });
  state.truncatedBudgetRounds += 1;
  const desired = Math.min(
    ports.maxStepCompletionTokens,
    Math.max(completionBudget, completionBudget * 2),
  );
  state.continuationBudgetFloor =
    profile.limits.outputTokens === undefined
      ? desired
      : Math.min(desired, profile.limits.outputTokens);
  state.retryWithoutThinking = profile.reasoning.generation !== "mandatory";
  if (input.hasThinking) {
    state.interruptedReasoning = appendInterruptedReasoning(
      state.interruptedReasoning,
      input.assistantThinkContent,
    );
  }
  const preservedReasoning = state.interruptedReasoning;
  const hasVisible = Boolean(input.canonicalVisible.trim());
  if (hasVisible) {
    state.visibleCommitted = true;
    ports.pushAssistantHistory(input.assistantVisible);
    state.interruptedVisible = input.canonicalVisible;
    state.lowYieldResumptions = 0;
  } else {
    ports.commitAssistantRetry(input.assistantVisible);
    state.interruptedReasoning = preservedReasoning;
  }
  ports.notify(
    "warn",
    state.retryWithoutThinking
      ? "response used the whole output budget — preserving it and continuing once with optional reasoning disabled"
      : "response used the whole output budget — preserving it and continuing once at the route limit",
  );
  ports.messages.push(
    ports.recoveryUserMessage(
      continuationNudge(
        hasVisible,
        state.retryWithoutThinking,
        state.interruptedReasoning,
      ),
    ),
  );
  return "continue-round";
};

export const handleOutputBudgetExhaustion = (
  ports: OutputBudgetPorts,
  state: OutputBudgetState,
  input: OutputBudgetInput,
  completionBudget: number,
): OutputBudgetDecision => {
  if (state.truncatedBudgetRounds < MAX_OUTPUT_BUDGET_CONTINUATIONS) {
    return preserveAndContinue(ports, state, input, completionBudget);
  }
  const hasVisible = Boolean(input.canonicalVisible.trim());
  ports.notify(
    "warn",
    hasVisible
      ? "response reached the output limit again after its bounded continuation — returning the preserved partial answer"
      : "response reached the output limit again after its bounded continuation — stopping without restarting the reasoning",
  );
  if (hasVisible) return "proceed";
  ports.commitAssistantRetry(input.assistantVisible);
  return "stop-partial";
};
