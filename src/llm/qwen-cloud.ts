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

// Qwen Cloud documents this OpenAI-compatible endpoint for international
// accounts. See https://docs.qwencloud.com/developer-guides/getting-started/first-api-call
const baseUrl = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const qwenCloudProvider: LlmProvider = {
  id: "qwen-cloud",
  displayName: "Qwen Cloud",
  defaultModel: defaultModels["qwen-cloud"],
  envVar: "DASHSCOPE_API_KEY",
  // Qwen Cloud workspace keys use `sk-ws-...` and may contain periods in
  // addition to the usual URL-safe key characters.
  validateKey: (key: string) => /^sk-[A-Za-z0-9._-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
    const models = (data.data ?? [])
      .map((model) => model.id)
      .filter((model): model is string => Boolean(model))
      .sort();
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const model = request.model ?? defaultModels["qwen-cloud"];
    const text = await openAiCompatibleComplete({
      provider: "Qwen Cloud",
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
    return { text, provider: "qwen-cloud", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Qwen Cloud API key is required");
    const model = request.model ?? defaultModels["qwen-cloud"];
    const text = await openAiCompatibleStream({
      provider: "Qwen Cloud",
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
    return { text, provider: "qwen-cloud", model };
  },
};
