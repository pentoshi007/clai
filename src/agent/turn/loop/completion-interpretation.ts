import type { CompletionResult, ProviderId, TokenUsage } from "../../../types.js";
import { stripThinking } from "../../../ui/thinking.js";
import { trimExactContinuationOverlap } from "../continuation-overlap.js";
import { recordRequestTokenObservation } from "../../../llm/token-estimate-calibration.js";
import { contextAttemptFromOperationUsage } from "../../../llm/context-snapshot.js";

export interface CompletionUsagePorts {
  readonly dispatchedRawRequestTokens: number;
  readonly dispatchedRequestRoute:
    | { provider: ProviderId; model: string }
    | undefined;
  readonly emitTokenUsage: (input: {
    usage: TokenUsage;
    provider: ProviderId;
    model: string;
    attempt?: ReturnType<typeof contextAttemptFromOperationUsage> | undefined;
  }) => void;
  readonly audit: (
    event: string,
    payload: Readonly<Record<string, string | number | boolean | undefined>>,
  ) => Promise<void>;
}

export const accountCompletionUsage = async (
  ports: CompletionUsagePorts,
  completion: CompletionResult,
): Promise<void> => {
  const usage = completion.usage;
  if (!usage) return;
  const requestRouteMatched =
    ports.dispatchedRequestRoute?.provider === completion.provider &&
    ports.dispatchedRequestRoute.model === completion.model;
  if (
    usage.exact &&
    usage.promptTokens > 0 &&
    requestRouteMatched
  ) {
    recordRequestTokenObservation({
      provider: completion.provider,
      model: completion.model,
      estimatedRequestTokens: ports.dispatchedRawRequestTokens,
      actualPromptTokens: usage.promptTokens,
    });
  }
  const attempt = contextAttemptFromOperationUsage(completion.operationUsage);
  ports.emitTokenUsage({
    usage,
    provider: completion.provider,
    model: completion.model,
    ...(attempt.kind === "generation" ? { attempt } : {}),
  });

  const cacheRead = usage.cachedPromptTokens ?? 0;
  const cacheCreated = usage.cacheCreationTokens ?? 0;
  if (cacheRead === 0 && cacheCreated === 0) return;
  await ports.audit("agent.prompt.cache", {
    provider: completion.provider,
    model: completion.model,
    promptTokens: usage.promptTokens,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreated,
    hitRatio:
      usage.promptTokens > 0
        ? Number((cacheRead / usage.promptTokens).toFixed(3))
        : 0,
  });
};

export interface AssistantTextParts {
  readonly visible: string;
  readonly hasThinking: boolean;
  readonly thinkContent: string;
}

export interface InterpretedCompletion {
  readonly assistantText: AssistantTextParts;
  readonly canonicalVisible: string;
  readonly thinkContent: string;
  readonly retryReasoning: Pick<
    CompletionResult,
    "reasoningArtifacts" | "reasoningBlock"
  >;
}

export const interpretCompletion = (input: {
  readonly completion: CompletionResult;
  readonly streamedReasoningText: string;
  readonly interruptedVisible: string;
}): InterpretedCompletion => {
  const split = stripThinking(input.completion.text);
  const thinkContent = [
    input.streamedReasoningText.trim() ||
      (input.completion.reasoningBlock?.text ?? "").trim(),
    split.thinkContent,
  ]
    .filter(Boolean)
    .join("\n\n");
  const continuedVisible = trimExactContinuationOverlap(
    input.interruptedVisible,
    split.visible,
  );
  const hasThinking = thinkContent.length > 0;
  return {
    assistantText: {
      visible: continuedVisible,
      hasThinking,
      thinkContent,
    },
    canonicalVisible: input.interruptedVisible + continuedVisible,
    thinkContent,
    retryReasoning:
      input.completion.reasoningArtifacts?.length ||
      input.completion.reasoningBlock
        ? input.completion
        : hasThinking
          ? { reasoningBlock: { text: thinkContent } }
          : input.completion,
  };
};
