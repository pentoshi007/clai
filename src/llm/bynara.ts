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
  readJson,
} from "./http.js";

// Bynara Router exposes an OpenAI-compatible Chat Completions API at
// https://router.bynara.id/v1. API keys usually start with sk_nry_.
const baseUrl = "https://router.bynara.id/v1";

// Cache model lists per API key so swapping keys (e.g. free → paid) refreshes
// the picker without waiting for a global TTL to expire.
interface ModelCache {
  models: string[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const bynaraProvider: LlmProvider = {
  id: "bynara",
  displayName: "Bynara",
  defaultModel: defaultModels.bynara,
  envVar: "BYNARA_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const key = auth.apiKey ?? "";
    const now = Date.now();
    const cached = modelCache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      const data = await readJson<{ data?: Array<{ id: string }> }>(resp);
      const models = data.data?.map((m) => m.id).sort() ?? [];
      if (models.length > 0) {
        modelCache.set(key, { models, fetchedAt: now });
      }
      return models;
    } catch {
      // Falls through to knownModels in repl.ts/App.tsx on failure.
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Bynara API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    const text = await openAiCompatibleComplete({
      provider: "Bynara",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
    });
    return { text, provider: "bynara", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    const text = await openAiCompatibleStream({
      provider: "Bynara",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      reasoning: request.thinking,
      reasoningStyle: "openai",
    });
    return { text, provider: "bynara", model };
  },
};
