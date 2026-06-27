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

// AgentRouter is an OpenAI-compatible Chat Completions gateway that
// proxies multiple frontier models (gpt-5, claude, glm, deepseek, etc.).
// API surface lives at https://agentrouter.org/v1 and accepts standard
// `Authorization: Bearer <key>` plus the OpenAI request body.
// Reference: https://agentrouter.org/console/token
const baseUrl = "https://agentrouter.org/v1";

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

export const agentrouterProvider: LlmProvider = {
  id: "agentrouter",
  displayName: "AgentRouter",
  defaultModel: defaultModels.agentrouter,
  envVar: "AGENTROUTER_API_KEY",
  // AgentRouter keys follow the `sk-...` shape used by their console.
  // We accept any non-trivial token starting with `sk-` so users can paste
  // newly-issued keys without us guessing the exact length.
  validateKey: (key: string) => /^sk-[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    const data = await readJson<{ data?: Array<{ id: string }> }>(response);
    const models = data.data?.map((m) => m.id).sort() ?? [];
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const model = request.model ?? defaultModels.agentrouter;
    const text = await openAiCompatibleComplete({
      provider: "AgentRouter",
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
    return { text, provider: "agentrouter", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const model = request.model ?? defaultModels.agentrouter;
    const text = await openAiCompatibleStream({
      provider: "AgentRouter",
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
      // AgentRouter's upstreams (gpt-5, claude opus, etc.) often spend
      // 30-60s on initial reasoning before the first token; mirror Codex's
      // recommended 5-minute idle timeout so the UI doesn't bail early.
      idleTimeoutMs: 300_000,
    });
    return { text, provider: "agentrouter", model };
  },
};
