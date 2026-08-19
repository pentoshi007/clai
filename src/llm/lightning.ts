import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  normalizeEndpointUrl,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";

/**
 * Lightning AI Model APIs — an OpenAI-compatible gateway in front of hosted
 * OpenAI, Anthropic, Google and Lightning-served open models, billed per token.
 * https://lightning.ai/docs/platform/inference/model-apis
 *
 * Model ids are vendor-namespaced (openai/gpt-5, anthropic/claude-opus-4-8,
 * google/gemini-3.5-flash, lightning-ai/gpt-oss-120b).
 */
export const LIGHTNING_DEFAULT_BASE_URL = "https://lightning.ai/api/v1";

/**
 * The shared gateway unless the user configured an override — e.g. a private
 * Lightning Inference deployment, which serves the same OpenAI-compatible
 * routes on its own URL.
 */
function resolveBaseUrl(auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || LIGHTNING_DEFAULT_BASE_URL;
}

// Keyed by base URL: switching deployments must not serve a stale catalog.
const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const lightningProvider: LlmProvider = {
  id: "lightning",
  reasoningStyle: "openai",
  displayName: "Lightning AI",
  defaultModel: defaultModels.lightning,
  envVar: "LIGHTNING_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_.-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const baseUrl = resolveBaseUrl(auth);
    const now = Date.now();
    const cached = modelCache.get(baseUrl);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
      // The catalog lists one entry per published agent/preset, so the same
      // model id appears several times — dedupe or the picker shows repeats.
      const models = ingestOpenAiModelCatalog("lightning", data);
      if (models.length > 0) {
        modelCache.set(baseUrl, { models, fetchedAt: now });
      }
      return models;
    } catch {
      // Falls back to the static catalog in the pickers.
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Lightning AI API key is required");
    await openAiCompatiblePing(resolveBaseUrl(auth), auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Lightning AI API key is required");
    const model = request.model ?? defaultModels.lightning;
    const payload = await openAiCompatibleComplete({
      provider: "Lightning AI",
      providerId: "lightning",
      baseUrl: resolveBaseUrl(auth),
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("lightning", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Lightning AI API key is required");
    const model = request.model ?? defaultModels.lightning;
    const payload = await openAiCompatibleStream({
      provider: "Lightning AI",
      providerId: "lightning",
      baseUrl: resolveBaseUrl(auth),
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("lightning", model, payload);
  },
};
