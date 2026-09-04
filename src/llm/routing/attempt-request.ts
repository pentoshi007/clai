import { applyImageViewAvailability } from "../../prompts/index.js";
import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptReason,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import {
  markModelUnavailable,
  modelAcceptsImages,
  modelSupportsVision,
  visionSubstitutionOrigin,
} from "../capabilities.js";
import { buildReasoningPayload, stripImagesFromMessages } from "../http.js";
import type { ReasoningStyle } from "../http.js";
import { isBuiltInProviderId } from "../provider-profile.js";
import { resolveBuiltInProfile } from "../provider-profiles.js";
import { isOperationPolicyError } from "../operation-ledger.js";
import { runGenerationAttempt } from "../operation-usage.js";
import { isModelNotFoundError } from "./error-classification.js";

export function successfulRequestSnapshot(
  provider: ProviderId,
  model: string,
  request: CompletionRequest,
): SuccessfulRequestSnapshot {
  return structuredClone({
    provider,
    model,
    messages: request.messages,
    ...(request.temperature !== undefined
      ? { temperature: request.temperature }
      : {}),
    ...(request.thinking ? { thinking: request.thinking } : {}),
    ...(request.tools ? { tools: request.tools } : {}),
    ...(request.toolChoice !== undefined
      ? { toolChoice: request.toolChoice }
      : {}),
    ...(request.parallelToolCalls !== undefined
      ? { parallelToolCalls: request.parallelToolCalls }
      : {}),
  });
}

export function preservedFailure(
  recoveryError: unknown,
  originalError: unknown,
): unknown {
  return isOperationPolicyError(recoveryError) ? originalError : recoveryError;
}

export function withoutReasoning(
  request: CompletionRequest,
): CompletionRequest {
  return { ...request, thinking: undefined };
}

export function reasoningWireKey(
  thinking: CompletionRequest["thinking"],
  style: ReasoningStyle,
  model: string,
  providerId: ProviderId,
): string {
  const control = isBuiltInProviderId(providerId)
    ? {
        profile: resolveBuiltInProfile({ provider: providerId, model }),
        willReplayReasoning: false,
      }
    : undefined;
  return JSON.stringify(
    buildReasoningPayload(thinking, style, model, providerId, control),
  );
}

const SELF_RECORDED_PROVIDERS = new Set<ProviderId>([
  "agentrouter",
  "bynara",
  "meta",
]);

export async function runRecordedProviderAttempt(input: {
  providerId: ProviderId;
  model: string;
  mode: "complete" | "stream";
  reason: GenerationAttemptReason;
  request: CompletionRequest;
  run: () => Promise<CompletionResult>;
}): Promise<CompletionResult> {
  if (SELF_RECORDED_PROVIDERS.has(input.providerId)) return input.run();
  return runGenerationAttempt(
    input.request,
    {
      provider: input.providerId,
      model: input.model,
      mode: input.mode,
      reason: input.reason,
    },
    input.run,
  );
}

export function requestForRoute(
  request: CompletionRequest,
  provider: ProviderId,
  model: string,
): CompletionRequest {
  if (modelSupportsVision(provider, model)) return request;

  const tools = request.tools?.filter((tool) => tool.name !== "image.view");
  const forcedImageView =
    typeof request.toolChoice === "object" &&
    request.toolChoice.name === "image.view";
  const messages = request.messages.map((message) =>
    message.role === "system" && message.content.includes("image.view")
      ? {
          ...message,
          content: applyImageViewAvailability(message.content, false),
        }
      : message,
  );
  return {
    ...request,
    messages,
    ...(request.tools ? { tools } : {}),
    ...(forcedImageView
      ? { toolChoice: tools?.length ? ("auto" as const) : undefined }
      : {}),
    ...(!tools?.length && request.tools
      ? { parallelToolCalls: undefined }
      : {}),
  };
}

export function hasImageInput(request: CompletionRequest): boolean {
  return request.messages.some((message) => message.images?.length);
}

export function withoutImages(request: CompletionRequest): CompletionRequest {
  return { ...request, messages: stripImagesFromMessages(request.messages) };
}

export function revertVisionSubstitution(
  providerId: ProviderId,
  model: string,
  request: CompletionRequest,
  error: unknown,
): { request: CompletionRequest; original: string } | undefined {
  if (!isModelNotFoundError(error)) return undefined;
  const original = visionSubstitutionOrigin(providerId, model);
  if (!original) return undefined;
  markModelUnavailable(providerId, model);
  const keepImages = modelAcceptsImages(providerId, original);
  const restoredRequest: CompletionRequest = {
    ...request,
    model: original,
    messages: keepImages
      ? request.messages
      : stripImagesFromMessages(request.messages),
  };
  return {
    original,
    request: requestForRoute(restoredRequest, providerId, original),
  };
}
