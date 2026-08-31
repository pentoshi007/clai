import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptReason,
  ProviderId,
} from "../../types.js";
import {
  learnModelVisionCapability,
  markReasoningMandatory,
  markReasoningUnsupported,
  registerWireRejectionEfforts,
} from "../capabilities.js";
import {
  isImageInputUnsupportedError,
  reasoningRejectionAdvice,
} from "../http.js";
import type { LlmProvider, ProviderAuth } from "../provider.js";
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
  revertVisionSubstitution,
  runRecordedProviderAttempt,
  withoutImages,
  withoutReasoning,
} from "./attempt-request.js";
import {
  effortCandidatesFor,
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
  const activeRequest = { ...request, provider: providerId, model };
  const runAttempt = (
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
  try {
    const result = await runAttempt(activeRequest, reason);
    if (hasImageInput(activeRequest)) {
      learnModelVisionCapability(providerId, model, true);
    }
    return result;
  } catch (error) {
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
        return await runAttempt(
          { ...activeRequest, forceReasoningReplay: true },
          "adaptation",
        );
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
        if (!advice?.mandatory) markReasoningUnsupported(providerId, model);
        throw error;
      }
      const thinking = activeRequest.thinking;
      if (thinking?.enabled) {
        const style = provider.reasoningStyle ?? "none";
        const seen = new Set<string>([
          reasoningWireKey(thinking, style, model, providerId),
        ]);
        for (const effort of effortCandidatesFor(
          providerId,
          model,
          thinking.effort,
        )) {
          const candidate = { ...thinking, effort };
          const key = reasoningWireKey(candidate, style, model, providerId);
          if (seen.has(key)) continue;
          seen.add(key);
          onStatus?.(
            `ℹ ${providerId}/${model} rejected reasoning effort — retrying with ${effort}`,
          );
          const retryRequest = {
            ...activeRequest,
            thinking: candidate,
          };
          try {
            return await runAttempt(retryRequest, "adaptation");
          } catch (retryError) {
            if (!shouldContinueEffortLadder(retryError)) throw retryError;
          }
        }
      }
      if (!advice?.mandatory) markReasoningUnsupported(providerId, model);
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
    if (hasImageInput(activeRequest) && isImageInputUnsupportedError(error)) {
      learnModelVisionCapability(providerId, model, false);
      if (singleDispatch) throw error;
      return await runAttempt(withoutImages(activeRequest), "adaptation");
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
