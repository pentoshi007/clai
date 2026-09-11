import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptReason,
  ProviderId,
} from "../../types.js";
import {
  learnModelVisionCapability,
  learnRejectedEffort,
  markReasoningMandatory,
  markReasoningUnsupported,
  registerWireRejectionEfforts,
} from "../capabilities.js";
import {
  isImageInputUnsupportedError,
  reasoningRejectionAdvice,
  isReasoningUnsupportedError,
} from "../http.js";
import type { LlmProvider, ProviderAuth } from "../provider.js";
import { withRequestOptionFallback } from "./request-option-fallback.js";
import {
  isMissingReasoningContentError,
  isUnattributableRequestBodyError,
} from "../reasoning-errors.js";
import {
  isToolsUnsupportedError,
  markTextOnlyModel,
} from "../tool-protocol.js";
import {
  hasImageInput,
  reasoningWireKey,
  requestForRoute,
  revertVisionSubstitution,
  runRecordedProviderAttempt,
  withoutImages,
  withoutReasoning,
} from "./attempt-request.js";
import {
  effortCandidatesFor,
  isReasoningRelatedServerError,
  shouldContinueEffortLadder,
  shouldEnterEffortLadder,
} from "./error-classification.js";

export async function tryCompleteOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
  reason: GenerationAttemptReason,
  onStatus: ((message: string) => void) | undefined,
  singleDispatch = false,
): Promise<CompletionResult> {
  const activeRequest = {
    ...requestForRoute(request, providerId, model),
    provider: providerId,
    model,
  };
  const dispatchAttempt = (
    candidate: CompletionRequest,
    attemptReason: GenerationAttemptReason,
  ): Promise<CompletionResult> => {
    const attemptRequest = { ...candidate, attemptReason };
    return runRecordedProviderAttempt({
      providerId,
      model: attemptRequest.model ?? model,
      mode: "complete",
      reason: attemptReason,
      request: attemptRequest,
      run: () => provider.complete(attemptRequest, auth),
    });
  };
  const runAttempt = (
    candidate: CompletionRequest,
    attemptReason: GenerationAttemptReason,
  ): Promise<CompletionResult> =>
    withRequestOptionFallback(
      candidate,
      attemptReason,
      dispatchAttempt,
      () => !singleDispatch,
      onStatus,
    );
  const initialReasoningWireKey = reasoningWireKey(
    activeRequest.thinking,
    provider.reasoningStyle ?? "none",
    model,
    providerId,
  );
  try {
    const result = await runAttempt(activeRequest, reason);
    if (hasImageInput(activeRequest)) {
      learnModelVisionCapability(providerId, model, true);
    }
    return result;
  } catch (error) {
    if (hasImageInput(activeRequest) && isImageInputUnsupportedError(error)) {
      learnModelVisionCapability(providerId, model, false);
      if (singleDispatch) throw error;
      onStatus?.(
        `ℹ ${providerId}/${model} rejected image input — continuing without images; their contents are unavailable to this model`,
      );
      return await runAttempt(
        requestForRoute(withoutImages(activeRequest), providerId, model),
        "adaptation",
      );
    }
    if (activeRequest.tools?.length && isToolsUnsupportedError(error)) {
      markTextOnlyModel(providerId, model);
      if (singleDispatch) throw error;
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      return await runAttempt(textRequest, "adaptation");
    }
    if (
      isMissingReasoningContentError(error) &&
      !activeRequest.forceReasoningReplay
    ) {
      if (singleDispatch) throw error;
      onStatus?.(
        `ℹ ${providerId}/${model} needs its reasoning replayed — retrying with it attached`,
      );
      try {
        const result = await runAttempt(
          { ...activeRequest, forceReasoningReplay: true },
          "adaptation",
        );
        markReasoningMandatory(providerId, model);
        return result;
      } catch (retryError) {
        if (!isMissingReasoningContentError(retryError)) throw retryError;
        return await runAttempt(withoutReasoning(activeRequest), "adaptation");
      }
    }
    if (
      shouldEnterEffortLadder(
        error,
        activeRequest.thinking,
        providerId,
        model,
        singleDispatch,
      )
    ) {
      const advice = reasoningRejectionAdvice(error);
      if (advice?.acceptedEfforts.length) {
        registerWireRejectionEfforts(providerId, model, advice.acceptedEfforts);
      }
      if (advice?.mandatory) markReasoningMandatory(providerId, model);
      if (singleDispatch) {
        if (!advice?.mandatory && activeRequest.thinking?.effort !== "none") {
          markReasoningUnsupported(providerId, model);
        }
        throw error;
      }
      const thinking = activeRequest.thinking;
      let attemptedRung = false;
      if (thinking && (thinking.enabled || thinking.effort === "none")) {
        const style = provider.reasoningStyle ?? "none";
        const seen = new Set<string>([initialReasoningWireKey]);
        const rejectedEfforts = [thinking.effort];
        for (const effort of effortCandidatesFor(
          providerId,
          model,
          thinking.effort,
        )) {
          const candidate = { ...thinking, enabled: effort !== "none", effort };
          const key = reasoningWireKey(candidate, style, model, providerId);
          if (seen.has(key)) continue;
          seen.add(key);
          attemptedRung = true;
          onStatus?.(
            `ℹ ${providerId}/${model} rejected reasoning effort — retrying with ${effort}`,
          );
          const retryRequest = {
            ...activeRequest,
            thinking: candidate,
          };
          try {
            const result = await runAttempt(retryRequest, "adaptation");
            for (const rejected of rejectedEfforts) {
              learnRejectedEffort(providerId, model, rejected);
            }
            return result;
          } catch (retryError) {
            if (!shouldContinueEffortLadder(retryError)) throw retryError;
            rejectedEfforts.push(effort);
          }
        }
      }
      const reasoningAttributed =
        isReasoningUnsupportedError(error) ||
        isReasoningRelatedServerError(error);
      if (!attemptedRung && !reasoningAttributed) {
        throw error;
      }
      if (!advice?.mandatory && thinking?.effort !== "none") {
        markReasoningUnsupported(providerId, model);
      }
      onStatus?.(
        advice?.mandatory
          ? `ℹ ${providerId}/${model} requires reasoning — retrying at its lowest accepted effort`
          : `ℹ ${providerId}/${model} rejected reasoning options — retrying without them`,
      );
      return await runAttempt(withoutReasoning(activeRequest), "adaptation");
    }
    if (
      !singleDispatch &&
      activeRequest.thinking?.enabled &&
      isUnattributableRequestBodyError(error)
    ) {
      onStatus?.(
        `ℹ ${providerId}/${model} rejected the request body — retrying without reasoning options`,
      );
      return await runAttempt(withoutReasoning(activeRequest), "adaptation");
    }
    if (!singleDispatch) {
      const restored = revertVisionSubstitution(
        providerId,
        model,
        activeRequest,
        error,
      );
      if (restored) {
        return await runAttempt(restored.request, "adaptation");
      }
    }
    throw error;
  }
}
