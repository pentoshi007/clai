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

export const LIGHTNING_DEFAULT_BASE_URL = "https://lightning.ai/api/v1";

function resolveBaseUrl(auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || LIGHTNING_DEFAULT_BASE_URL;
}

const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

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
      const models = ingestOpenAiModelCatalog("lightning", data);
      if (models.length > 0) {
        modelCache.set(baseUrl, { models, fetchedAt: now });
      }
      return models;
    } catch {
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
