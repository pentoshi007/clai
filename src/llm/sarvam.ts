import type { CompletionRequest, CompletionResult } from "../types.js";
import { sessionCacheAffinityKey } from "./cache-affinity.js";
import { modelCatalogFacts } from "./capabilities.js";
import { buildReasoningPayload, openAiCompatibleComplete, openAiCompatibleStream, ProviderError, toCompletionResult } from "./http.js";
import { mainEffortProbe } from "./main-effort-discovery.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import { resolveBuiltInProfile } from "./provider-profiles.js";
import { currentRequestPurpose } from "./request-purpose.js";
import { responsesComplete, responsesStream, type ResponsesDialectConfig } from "./responses-dialect.js";
import {
  listSarvamModels,
  pingSarvam,
  sarvamAuthHeaders,
  sarvamCredentials,
  withSarvamModelMetadata,
} from "./sarvam-catalog.js";
import { sarvamOmitsEffort, sarvamWireApi } from "./sarvam-models.js";
import { SARVAM_RESPONSES_TERMINAL } from "./sarvam-profile.js";
import { currentSessionAffinity } from "./session-affinity.js";

const DISPLAY_NAME = "Sarvam Token Factory";

function compatibleToolChoice(request: CompletionRequest, model: string): CompletionRequest {
  const choice = request.toolChoice;
  if (typeof choice !== "object") return request;
  const choices = modelCatalogFacts("sarvam", model)?.toolChoices;
  if (!choices?.includes("required") || choices.includes("named")) return request;
  const tool = request.tools?.find(({ name }) => name === choice.name);
  return tool ? { ...request, tools: [tool], toolChoice: "required" } : request;
}

function isKeyScopedError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  if (error.status === 400 && /not enabled for (?:your|this) organi[sz]ation/i.test(error.message)) return true;
  const body = error.body ?? "";
  return error.status === 404 && body.includes('"not_found_error"') && /\bmodel\b[^\n]*\bnot found\b/i.test(body);
}

function chatOptions(request: CompletionRequest, auth: ProviderAuth, model: string) {
  const { baseUrl, apiKey } = sarvamCredentials(auth);
  const headers = sarvamAuthHeaders(apiKey);
  const session = currentSessionAffinity();
  const purpose = request.purpose ?? currentRequestPurpose();
  if (model === "gemma4" && session && (!purpose || purpose === "turn" || purpose === "compaction") &&
      mainEffortProbe("sarvam", model) === undefined) {
    headers["x-session-affinity"] = sessionCacheAffinityKey(session);
  }
  return {
    provider: DISPLAY_NAME,
    providerId: "sarvam" as const,
    baseUrl,
    apiKey: "",
    headers,
    redirect: "error" as const,
    forwardSessionAffinity: false,
    model,
    messages: request.messages,
    maxTokens: request.maxTokens,
    temperature: request.temperature,
    signal: request.signal,
    reasoning: request.thinking,
    reasoningStyle: "openai" as const,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    forceReasoningReplay: request.forceReasoningReplay,
    purpose,
  };
}

function responsesConfig(auth: ProviderAuth): ResponsesDialectConfig {
  const { apiKey, baseUrl } = sarvamCredentials(auth);
  return {
    baseUrl: `${baseUrl}/responses`,
    providerId: "sarvam",
    displayName: DISPLAY_NAME,
    artifactDialect: "openai-compatible",
    terminalPolicy: SARVAM_RESPONSES_TERMINAL,
    redirect: "error",
    forwardSessionAffinity: false,
    reasoningContent: true,
    buildHeaders(_auth, accept) {
      return { accept, "content-type": "application/json", ...sarvamAuthHeaders(apiKey) };
    },
    reasoningPayload(reasoning, model) {
      if (!reasoning || !model) return undefined;
      const { reasoning_effort: effort } = buildReasoningPayload(reasoning, "openai", model, "sarvam", {
        profile: resolveBuiltInProfile({ provider: "sarvam", model }),
        willReplayReasoning: false,
      });
      return typeof effort === "string" && !sarvamOmitsEffort(model, effort)
        ? { effort }
        : undefined;
    },
    bodyExtras: () => ({ store: false }),
    finalizeBody(body) {
      const choice = body.tool_choice as { function?: { name?: unknown } } | undefined;
      if (typeof choice?.function?.name === "string") {
        body.tool_choice = { type: "function", name: choice.function.name };
      }
      return body;
    },
  };
}

function generate(
  input: CompletionRequest,
  auth: ProviderAuth,
  onToken?: (token: string) => void,
): Promise<CompletionResult> {
  const model = input.model ?? defaultModels.sarvam;
  return withSarvamModelMetadata(model, auth, input.signal, async () => {
    const request = compatibleToolChoice(input, model);
    if (sarvamWireApi() === "responses") {
      const config = responsesConfig(auth);
      return onToken
        ? responsesStream(config, request, auth, onToken, model)
        : responsesComplete(config, request, auth, model);
    }
    const options = chatOptions(request, auth, model);
    const result = onToken
      ? await openAiCompatibleStream({
          ...options,
          onToken,
          onToolCallDelta: request.onToolCallDelta,
          onStreamEvent: request.onStreamEvent,
        })
      : await openAiCompatibleComplete(options);
    return toCompletionResult("sarvam", model, result);
  });
}

export const sarvamProvider: LlmProvider = {
  id: "sarvam",
  displayName: DISPLAY_NAME,
  defaultModel: defaultModels.sarvam,
  envVar: "SARVAM_API_KEY",
  reasoningStyle: "openai",
  validateKey: (key) => /^[\x21-\x7e]+$/.test(key),
  listModels: listSarvamModels,
  ping: pingSarvam,
  isKeyScopedError,
  withModelMetadata: withSarvamModelMetadata,
  complete: (request, auth) => generate(request, auth),
  stream: (request, auth, onToken) => generate(request, auth, onToken),
};
