import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  normalizeEndpointUrl,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { singleLeadingSystemMessages } from "./system-messages.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";

/**
 * TokenRouter — an OpenAI-compatible gateway to frontier open models (Kimi,
 * DeepSeek, Qwen, GLM, GPT-OSS, MiniMax) behind one bearer key. Chat
 * Completions at `/chat/completions`, model list at `/models`, SSE streaming,
 * native tools, JSON mode. Reasoning models return their thinking in
 * `reasoning_content`, which the shared OpenAI helper already folds into a
 * <think> block.
 *
 * TokenRouter is reachable on more than one host, so the base URL is an
 * override-able endpoint (same mechanism as Modal/Lightning) rather than a
 * hard constant.
 */
export const TOKENROUTER_DEFAULT_BASE_URL = "https://api.tokenrouter.com/v1";

function resolveBaseUrl(auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || TOKENROUTER_DEFAULT_BASE_URL;
}

// Keyed by base URL + key: `/models` returns only the channels a key can use.
const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const tokenrouterProvider: LlmProvider = {
  id: "tokenrouter",
  displayName: "TokenRouter",
  defaultModel: defaultModels.tokenrouter,
  envVar: "TOKENROUTER_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_.-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const baseUrl = resolveBaseUrl(auth);
    const cacheKey = `${baseUrl}|${auth.apiKey ?? ""}`;
    const now = Date.now();
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
      const models = ingestOpenAiModelCatalog("tokenrouter", data);
      if (models.length > 0) {
        modelCache.set(cacheKey, { models, fetchedAt: now });
        return models;
      }
      return cached?.models ?? models;
    } catch {
      return cached?.models ?? [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("TokenRouter API key is required");
    await openAiCompatiblePing(resolveBaseUrl(auth), auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("TokenRouter API key is required");
    const model = request.model ?? defaultModels.tokenrouter;
    const payload = await openAiCompatibleComplete({
      provider: "TokenRouter",
      providerId: "tokenrouter",
      baseUrl: resolveBaseUrl(auth),
      apiKey: auth.apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
    });
    return toCompletionResult("tokenrouter", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("TokenRouter API key is required");
    const model = request.model ?? defaultModels.tokenrouter;
    const payload = await openAiCompatibleStream({
      provider: "TokenRouter",
      providerId: "tokenrouter",
      baseUrl: resolveBaseUrl(auth),
      apiKey: auth.apiKey,
      model,
      messages: singleLeadingSystemMessages(request.messages),
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
    });
    return toCompletionResult("tokenrouter", model, payload);
  },
};
