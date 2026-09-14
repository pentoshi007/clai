import { applyImageViewAvailability } from "../../prompts/index.js";
import type {
  CompletionRequest,
  CompletionResult,
  GenerationAttemptReason,
  ProviderId,
  ReasoningEffort,
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
import { runGenerationAttempt, withUnrecordedTransport } from "../operation-usage.js";
import {
  needsEffortPreflight,
  runEffortPreflight,
  PREFLIGHT_MAX_TOKENS,
  PREFLIGHT_MESSAGES,
  type EffortPreflightRoute,
  type EffortProbeOutcome,
} from "../wire/effort-preflight.js";
import { isModelNotFoundError, shouldContinueEffortLadder } from "./error-classification.js";
import type { LlmProvider, ProviderAuth } from "../provider.js";

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
  const profile = isBuiltInProviderId(providerId)
    ? resolveBuiltInProfile({ provider: providerId, model })
    : undefined;
  const control =
    profile && profile.reasoning.control.status === "supported"
      ? { profile, willReplayReasoning: false }
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

export interface EffortPreflightInput {
  provider: LlmProvider;
  providerId: ProviderId;
  model: string;
  request: CompletionRequest;
  auth: ProviderAuth;
  singleDispatch: boolean;
  onStatus: ((message: string) => void) | undefined;
}

function probeRequestFor(
  request: CompletionRequest,
  effort: ReasoningEffort,
): CompletionRequest {
  return {
    ...request,
    messages: [...PREFLIGHT_MESSAGES],
    maxTokens: PREFLIGHT_MAX_TOKENS,
    tools: undefined,
    toolChoice: undefined,
    parallelToolCalls: undefined,
    attemptUsage: undefined,
    onToolCallDelta: undefined,
    onStreamEvent: undefined,
    onReasoningArtifactReplayDecision: undefined,
    thinking: { enabled: effort !== "none", effort },
  };
}

async function probeEffort(
  input: EffortPreflightInput,
  effort: ReasoningEffort,
): Promise<EffortProbeOutcome> {
  const probe = probeRequestFor(input.request, effort);
  try {
    await withUnrecordedTransport(
      () => input.provider.complete(probe, input.auth),
      PREFLIGHT_MAX_TOKENS,
    );
    return "accepted";
  } catch (error) {
    return shouldContinueEffortLadder(error) ? "unsupported" : "abort";
  }
}

export async function preflightEffort(
  input: EffortPreflightInput,
): Promise<void> {
  if (input.singleDispatch) return;
  const thinking = input.request.thinking;
  if (!thinking) return;
  if (!thinking.enabled && thinking.effort !== "none") return;
  const route: EffortPreflightRoute = {
    providerId: input.providerId,
    model: input.model,
    endpoint: input.auth.baseUrl,
    requested: thinking.effort,
    purpose: input.request.purpose,
  };
  if (!needsEffortPreflight(route)) return;
  input.onStatus?.(
    `i ${input.providerId}/${input.model} checking which reasoning efforts it accepts`,
  );
  await runEffortPreflight(route, (effort) => probeEffort(input, effort));
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
  const routeMessages = modelAcceptsImages(provider, model)
    ? request.messages
    : stripImagesFromMessages(request.messages);
  const messages = routeMessages.map((message) =>
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
