import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
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

const baseUrl = "https://openrouter.ai/api/v1";
const headers = {
  "HTTP-Referer": "https://github.com/clai/clai",
  "X-Title": "clai",
};

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const openrouterProvider: LlmProvider = {
  id: "openrouter",
  reasoningStyle: "openrouter",
  displayName: "OpenRouter",
  defaultModel: defaultModels.openrouter,
  envVar: "OPENROUTER_API_KEY",
  validateKey: (key: string) => /^(sk-or-|or-)[A-Za-z0-9_-]{12,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const reqHeaders: Record<string, string> = { ...headers };
    if (auth.apiKey) {
      reqHeaders["authorization"] = `Bearer ${auth.apiKey}`;
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers: reqHeaders,
    });
    const data = await readJson<{ data?: Array<{ id: string }> }>(response);
    const models = ingestOpenAiModelCatalog("openrouter", data);
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("OpenRouter API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey, headers);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenRouter API key is required");
    const model = request.model ?? defaultModels.openrouter;
    const payload = await openAiCompatibleComplete({
      responsesFirst: true,
      provider: "OpenRouter",
      providerId: "openrouter",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openrouter",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("openrouter", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenRouter API key is required");
    const model = request.model ?? defaultModels.openrouter;
    const payload = await openAiCompatibleStream({
      responsesFirst: true,
      provider: "OpenRouter",
      providerId: "openrouter",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "openrouter",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("openrouter", model, payload);
  },
};
