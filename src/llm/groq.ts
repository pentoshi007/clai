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

const baseUrl = "https://api.groq.com/openai/v1";

export const groqFallbackModels = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-safeguard-20b",
  "qwen/qwen3-32b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "groq/compound-mini",
  "groq/compound",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

export function groqMaxTokens(
  model: string,
  requested: number | undefined,
): number | undefined {
  const m = model.toLowerCase();
  const cap = /openai\/gpt-oss-120b/.test(m)
    ? 1_024
    : /openai\/gpt-oss-20b|qwen\/qwen3-32b/.test(m)
      ? 2_048
      : undefined;
  if (!cap) return requested;
  return Math.min(requested ?? cap, cap);
}

export const groqProvider: LlmProvider = {
  id: "groq",
  displayName: "Groq",
  defaultModel: defaultModels.groq,
  envVar: "GROQ_API_KEY",
  validateKey: (key: string) => /^gsk_[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) {
      return groqFallbackModels;
    }
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${auth.apiKey}`,
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      const models = data.data?.map((m) => m.id).sort() ?? [];
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return groqFallbackModels;
    } catch {
      return groqFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    const model = request.model ?? defaultModels.groq;
    const text = await openAiCompatibleComplete({
      provider: "Groq",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: groqMaxTokens(model, request.maxTokens),
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "groq",
    });
    return { text, provider: "groq", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Groq API key is required");
    const model = request.model ?? defaultModels.groq;
    const text = await openAiCompatibleStream({
      provider: "Groq",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: groqMaxTokens(model, request.maxTokens),
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      reasoning: request.thinking,
      reasoningStyle: "groq",
    });
    return { text, provider: "groq", model };
  },
};
