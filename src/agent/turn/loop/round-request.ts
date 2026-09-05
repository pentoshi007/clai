import type { RequestAssemblyState } from "../../turn/loop/request-assembly.js";
import type { StreamFailureState } from "../../turn/loop/stream-failure.js";
import { operationUsageFromError } from "../../../llm/operation-ledger.js";
import { streamWithProvider } from "../../../llm/router.js";
import { streamAlreadyEmitted } from "../../../llm/stream-progress.js";
import { auditLog } from "../../../store/logs.js";
import { jobManager } from "../../../tools/jobs.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../../../ui-core/rendering/sanitize-display.js";
import { rememberThinking } from "../../../ui/thinking.js";
import { RequestOverLimitError } from "../../request-accounting.js";
import { classifyStreamFailure, resetStreamRecoveryState } from "../../stream-recovery.js";
import { assembleRequest } from "../../turn/loop/request-assembly.js";
import { recoverFromStreamFailure } from "../../turn/loop/stream-failure.js";
import { buildStreamRequest } from "../../turn/loop/stream-request.js";
import type { CompletionResult } from "../../../types.js";
import type { StreamSession } from "./stream-session.js";
import type { TurnLoopDeps } from "./deps.js";

export type RoundRequestResult =
  | { readonly kind: "continue" }
  | {
      readonly kind: "completed";
      readonly completion: CompletionResult;
      readonly toolsAttached: boolean;
    };

export interface RoundRequestInput {
  readonly streamSession: StreamSession;
  readonly responderDelivery: { readonly id: string } | undefined;
  readonly delay: (ms: number) => Promise<void>;
  readonly setToolsAttached: (attached: boolean) => void;
}

export const requestRound = async (
  deps: TurnLoopDeps,
  input: RoundRequestInput,
): Promise<RoundRequestResult> => {
  const { streamSession, responderDelivery } = input;
  let completion: CompletionResult | undefined;
  let toolsAttached = false;
  try {
    const resolved = deps.resolveNativeTools(deps.loop.provider, deps.loop.model);
    deps.setDialect(resolved.dialect, resolved.native);
    if (deps.messages[0]?.role === "system") {
      const nextSystem = deps.composeCurrentSystemPrompt(deps.nativeToolsActive());
      if (deps.messages[0].content !== nextSystem) {
        deps.messages[0] = {
          role: "system",
          content: nextSystem,
        };
      }
    }
    const assemblyState: RequestAssemblyState = {
      freeTierConsecutiveFailures: deps.loop.freeTierConsecutiveFailures,
      truncatedBudgetRounds: deps.loop.truncatedBudgetRounds,
      continuationBudgetFloor: deps.loop.continuationBudgetFloor,
      retryWithoutThinking: deps.loop.retryWithoutThinking,
    };
    const contextLimitTokens = deps.currentContextLimitTokens();
    try {
    const assembled = await assembleRequest(
      {
        messages: deps.messages,
        provider: deps.loop.provider,
        model: deps.loop.model,
        dialect: deps.dialect(),
        nativeToolsActive: deps.nativeToolsActive(),
        thinking: deps.thinking,
        step: deps.loop.step,
        contextLimitTokens,
        estimateRequestTokens: deps.estimateNextRequestTokens,
        selectTools: () =>
          deps.selectToolDefs(deps.nativeToolsActive(), deps.useCompactSystemPrompt),
        notify: deps.writeNotice,
        emitContextEstimate: (estimatedTokens) =>
          deps.emit({ type: "context-estimate", estimatedTokens, model: deps.loop.model }),
        audit: (event, payload) => auditLog(event, payload),
      },
      assemblyState,
    );
    const turnTools = assembled.tools;
    toolsAttached = assembled.toolsAttached;
    input.setToolsAttached(toolsAttached);
    deps.loop.stepMaxTokens = assembled.stepMaxTokens;
    deps.loop.dispatchedRawRequestTokens = assembled.rawRequestTokens;
    deps.loop.dispatchedRequestRoute = {
      provider: deps.loop.provider,
      model: deps.loop.model,
    };
    if (
      responderDelivery &&
      !jobManager.markDeliveryStarted(responderDelivery.id, deps.session.sessionId)
    ) {
      jobManager.releaseResponderNotificationClaim(
        responderDelivery.id,
      );
      throw new Error(
        `failed to record responder delivery attempt ${responderDelivery.id}`,
      );
    }
    completion = await streamWithProvider(
      buildStreamRequest({
        provider: deps.loop.provider,
        model: deps.loop.model,
        messages: deps.messages,
        allowModelFallback: deps.loop.allowModelFallback,
        preferModelFallback: deps.loop.preferModelFallback,
        maxTokens: deps.loop.stepMaxTokens,
        signal: deps.options.signal,
        thinking: deps.thinking,
        retryWithoutThinking: deps.loop.retryWithoutThinking,
        toolsAttached,
        tools: turnTools,
        onToolCallDelta: streamSession.onToolCallDelta,
      }),
      streamSession.onToken,
      {
        onStatus: streamSession.onStatus,
        onStreamEvent: streamSession.onStreamEvent,
        onSuccessfulRequest: streamSession.onSuccessfulRequest,
        retryRateLimits: false,
      },
    );
    deps.loop.freeTierConsecutiveFailures = 0;
    resetStreamRecoveryState(deps.recoveryState);
    deps.loop.allowModelFallback = false;
    deps.loop.preferModelFallback = false;
    deps.loop.lowYieldResumptions = 0;
    } catch (streamError) {
      if (deps.options.signal?.aborted) throw streamError;
      if (streamError instanceof RequestOverLimitError) throw streamError;

      const failedOperationUsage = operationUsageFromError(streamError);
      const failedAttempt = failedOperationUsage?.attempts.at(-1);
      const failedUsage = failedOperationUsage?.aggregate.usage;
      const failureState: StreamFailureState = {
        freeTierConsecutiveFailures: deps.loop.freeTierConsecutiveFailures,
        freeTierAdvisoryShown: deps.loop.freeTierAdvisoryShown,
        lowYieldResumptions: deps.loop.lowYieldResumptions,
        interruptedVisible: deps.loop.interruptedVisible,
        interruptedReasoning: deps.loop.interruptedReasoning,
        allowModelFallback: deps.loop.allowModelFallback,
        preferModelFallback: deps.loop.preferModelFallback,
        retryWithoutThinking: deps.loop.retryWithoutThinking,
        visibleCommitted: deps.outputState.visibleCommitted,
      };
      const decision = await recoverFromStreamFailure(
        {
          messages: deps.messages,
          recoveryState: deps.recoveryState,
          provider: deps.loop.provider,
          notify: deps.writeNotice,
          emitStatus: (text) => deps.emit({ type: "status", text }),
          emitTokenUsage: (usage, usageProvider, usageModel) =>
            deps.emit({
              type: "token-usage",
              usage,
              model: usageModel,
              provider: usageProvider,
            }),
          emitEmptyAssistantMessage: () =>
            deps.emit({ type: "assistant-message", text: "" }),
          writeAssistantMessage: deps.writeAssistantMessage,
          writeThinkingBlock: deps.writeThinkingBlock,
          writeToolBlocked: deps.writeToolBlocked,
          rememberThinking,
          sanitizeAssistantText,
          finishDeltaParser: streamSession.finishDeltaParser,
          recoveryUserMessage: deps.recoveryUserMessage,
          forceCompact: (reason) => deps.maybeAutoCompact(reason, true),
          delay: (ms) => input.delay(ms),
        },
        failureState,
        {
          kind: classifyStreamFailure(streamError),
          error: streamError,
          alreadyEmitted: streamAlreadyEmitted(streamError),
          attemptUsage:
            failedUsage && failedAttempt
              ? {
                usage: failedUsage,
                provider: failedAttempt.provider,
                model: failedAttempt.model,
              }
              : undefined,
          accumulatedText: streamSession.accumulatedText(),
          streamedReasoningText: streamSession.streamedReasoningText(),
          deferredToolCalls: streamSession.deferredToolCalls,
        },
      );
      deps.loop.freeTierConsecutiveFailures = failureState.freeTierConsecutiveFailures;
      deps.loop.freeTierAdvisoryShown = failureState.freeTierAdvisoryShown;
      deps.loop.lowYieldResumptions = failureState.lowYieldResumptions;
      deps.loop.interruptedVisible = failureState.interruptedVisible;
      deps.loop.interruptedReasoning = failureState.interruptedReasoning;
      deps.loop.allowModelFallback = failureState.allowModelFallback;
      deps.loop.preferModelFallback = failureState.preferModelFallback;
      deps.loop.retryWithoutThinking = failureState.retryWithoutThinking;
      deps.outputState.visibleCommitted = failureState.visibleCommitted;
      if (decision === "rethrow") throw streamError;
      return { kind: "continue" };
    }
  } finally {
    streamSession.stopHeartbeat();
  }
  return { kind: "completed", completion: completion!, toolsAttached };
};
