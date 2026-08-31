import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptReason,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolCallStreamDelta,
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
import { createStreamEventGuard } from "../stream-events.js";
import type { ProviderStreamEvent } from "../stream-events.js";
import { markStreamEmittedBytes } from "../stream-progress.js";
import {
  isToolsUnsupportedError,
  markTextOnlyModel,
} from "../tool-protocol.js";
import {
  hasImageInput,
  preservedFailure,
  reasoningWireKey,
  revertVisionSubstitution,
  runRecordedProviderAttempt,
  successfulRequestSnapshot,
  withoutImages,
  withoutReasoning,
} from "./attempt-request.js";
import {
  effortCandidatesFor,
  shouldContinueEffortLadder,
  shouldEnterEffortLadder,
} from "./error-classification.js";

export async function tryStreamOnce(
  provider: LlmProvider,
  providerId: ProviderId,
  request: CompletionRequest,
  model: string,
  auth: ProviderAuth,
  onToken: (token: string) => void,
  onStatus: ((message: string) => void) | undefined,
  reason: GenerationAttemptReason,
  singleDispatch = false,
  onSuccessfulRequest?:
    ((snapshot: SuccessfulRequestSnapshot) => void) | undefined,
): Promise<CompletionResult> {
  let emittedBytes = 0;
  let emittedToolArgumentBytes = 0;
  const onToolCallDelta = request.onToolCallDelta;
  const downstreamEvents = request.onStreamEvent;
  let guard = createStreamEventGuard();
  const startedToolCallIndexes = new Set<number>();
  const emitEvent = (event: ProviderStreamEvent): void => {
    guard.accept(event);
    if (event.type === "reasoning_delta" || event.type === "commentary_delta") {
      emittedBytes += event.text.length;
    }
    downstreamEvents?.(event);
  };
  const activeRequest = {
    ...request,
    provider: providerId,
    model,
    ...(onToolCallDelta || downstreamEvents
      ? {
          onToolCallDelta: (delta: ToolCallStreamDelta): void => {
            const argumentBytes = delta.argumentsBytes ?? 0;
            emittedBytes += Math.max(
              delta.name?.length ?? 0,
              argumentBytes - emittedToolArgumentBytes,
              1,
            );
            emittedToolArgumentBytes = Math.max(
              emittedToolArgumentBytes,
              argumentBytes,
            );
            if (
              delta.name !== undefined &&
              !startedToolCallIndexes.has(delta.index)
            ) {
              startedToolCallIndexes.add(delta.index);
              emitEvent({
                type: "tool_call_started",
                index: delta.index,
                ...(delta.id ? { id: delta.id } : {}),
                name: delta.name,
              });
            }
            emitEvent({
              type: "tool_arguments_delta",
              index: delta.index,
              ...(delta.id ? { id: delta.id } : {}),
              argumentsBytes: argumentBytes,
            });
            onToolCallDelta?.(delta);
          },
        }
      : {}),
    ...(downstreamEvents ? { onStreamEvent: emitEvent } : {}),
  };
  const emit = (token: string): void => {
    if (!token) return;
    emittedBytes += token.length;
    emitEvent({ type: "answer_delta", text: token });
    onToken(token);
  };
  const learnVisionOnSuccess = (): void => {
    if (hasImageInput(activeRequest)) {
      learnModelVisionCapability(providerId, model, true);
    }
  };
  const runAttempt = async (
    candidate: CompletionRequest,
    attemptReason: GenerationAttemptReason,
  ): Promise<CompletionResult> => {
    guard = createStreamEventGuard();
    startedToolCallIndexes.clear();
    const attemptRequest = { ...candidate, attemptReason };
    const result = await runRecordedProviderAttempt({
      providerId,
      model: attemptRequest.model ?? model,
      mode: "stream",
      reason: attemptReason,
      request: attemptRequest,
      run: async () => {
        let result: CompletionResult;
        if (provider.stream) {
          result = await provider.stream(attemptRequest, auth, emit);
        } else {
          result = await provider.complete(attemptRequest, auth);
          emit(result.text);
        }
        for (const [index, call] of (result.toolCalls ?? []).entries()) {
          if (!startedToolCallIndexes.has(index)) {
            startedToolCallIndexes.add(index);
            emitEvent({
              type: "tool_call_started",
              index,
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
            });
          }
          emitEvent({
            type: "tool_call_completed",
            index,
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
          });
        }
        if (result.usage) {
          emitEvent({ type: "usage_observed", usage: result.usage });
        }
        emitEvent({
          type: "provider_terminal",
          ...(result.finishReason ? { finishReason: result.finishReason } : {}),
        });
        return result;
      },
    });
    try {
      onSuccessfulRequest?.(
        successfulRequestSnapshot(
          result.provider || providerId,
          result.model || attemptRequest.model || model,
          attemptRequest,
        ),
      );
    } catch {}
    return result;
  };
  try {
    const result = await runAttempt(activeRequest, reason);
    learnVisionOnSuccess();
    return result;
  } catch (error) {
    if (
      emittedBytes === 0 &&
      activeRequest.tools?.length &&
      isToolsUnsupportedError(error)
    ) {
      markTextOnlyModel(providerId, model);
      if (singleDispatch) throw markStreamEmittedBytes(error, emittedBytes);
      onStatus?.(
        `ℹ ${providerId}/${model} does not support native tools — falling back to text protocol`,
      );
      const textRequest = {
        ...activeRequest,
        tools: undefined,
        toolChoice: undefined,
        parallelToolCalls: undefined,
      };
      try {
        return await runAttempt(textRequest, "adaptation");
      } catch (retryError) {
        throw markStreamEmittedBytes(
          preservedFailure(retryError, error),
          emittedBytes,
        );
      }
    }
    // Model rejected a reasoning/thinking knob (e.g. chat_template_kwargs on a
    // NIM chat template that does not accept it). A parameter rejection is a
    // request-time 4xx, so no tokens have streamed yet — retries are clean.
    // Walk down the effort ladder first (max → xhigh → high → medium → low) so
    // a model that merely rejects the highest requested depth keeps reasoning;
    // only strip reasoning entirely once every candidate has been rejected.
    if (
      emittedBytes === 0 &&
      isMissingReasoningContentError(error) &&
      !activeRequest.forceReasoningReplay
    ) {
      if (singleDispatch) throw markStreamEmittedBytes(error, emittedBytes);
      onStatus?.(
        `ℹ ${providerId}/${model} needs its reasoning replayed — retrying with it attached`,
      );
      try {
        return await runAttempt(
          { ...activeRequest, forceReasoningReplay: true },
          "adaptation",
        );
      } catch (retryError) {
        if (!isMissingReasoningContentError(retryError)) {
          throw markStreamEmittedBytes(
            preservedFailure(retryError, error),
            emittedBytes,
          );
        }
        return await runAttempt(withoutReasoning(activeRequest), "adaptation");
      }
    }
    if (
      emittedBytes === 0 &&
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
        throw markStreamEmittedBytes(error, emittedBytes);
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
            if (!shouldContinueEffortLadder(retryError)) {
              throw markStreamEmittedBytes(
                preservedFailure(retryError, error),
                emittedBytes,
              );
            }
          }
        }
      }
      if (!advice?.mandatory) markReasoningUnsupported(providerId, model);
      onStatus?.(
        advice?.mandatory
          ? `ℹ ${providerId}/${model} requires reasoning — retrying at its lowest accepted effort`
          : `ℹ ${providerId}/${model} rejected reasoning options — retrying without them`,
      );
      const retryRequest = withoutReasoning(activeRequest);
      try {
        return await runAttempt(retryRequest, "adaptation");
      } catch (retryError) {
        throw markStreamEmittedBytes(
          preservedFailure(retryError, error),
          emittedBytes,
        );
      }
    }
    if (
      emittedBytes === 0 &&
      !singleDispatch &&
      activeRequest.thinking?.enabled &&
      isUnattributableRequestBodyError(error)
    ) {
      onStatus?.(
        `ℹ ${providerId}/${model} rejected the request body — retrying without reasoning options`,
      );
      try {
        return await runAttempt(withoutReasoning(activeRequest), "adaptation");
      } catch (retryError) {
        throw markStreamEmittedBytes(
          preservedFailure(retryError, error),
          emittedBytes,
        );
      }
    }
    if (
      emittedBytes === 0 &&
      hasImageInput(activeRequest) &&
      isImageInputUnsupportedError(error)
    ) {
      learnModelVisionCapability(providerId, model, false);
      if (singleDispatch) throw markStreamEmittedBytes(error, emittedBytes);
      onStatus?.(
        `ℹ ${providerId}/${model} rejected image input — retrying without the attached image(s)`,
      );
      const textOnlyRequest = withoutImages(activeRequest);
      try {
        return await runAttempt(textOnlyRequest, "adaptation");
      } catch (retryError) {
        throw markStreamEmittedBytes(
          preservedFailure(retryError, error),
          emittedBytes,
        );
      }
    }
    if (emittedBytes === 0 && !singleDispatch) {
      const restored = revertVisionSubstitution(
        providerId,
        model,
        activeRequest,
        error,
      );
      if (restored) {
        onStatus?.(
          `ℹ ${providerId}/${model} is not available on this account — falling back to ${restored.original}`,
        );
        try {
          return await runAttempt(restored.request, "adaptation");
        } catch (retryError) {
          throw markStreamEmittedBytes(
            preservedFailure(retryError, error),
            emittedBytes,
          );
        }
      }
    }
    throw markStreamEmittedBytes(error, emittedBytes);
  }
}
