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
} from "./http.js";

const baseUrl = "https://openrouter.ai/api/v1";
const headers = {
  "HTTP-Referer": "https://github.com/clai/clai",
  "X-Title": "clai",
};

export const openrouterProvider: LlmProvider = {
  id: "openrouter",
  displayName: "OpenRouter",
  defaultModel: defaultModels.openrouter,
  envVar: "OPENROUTER_API_KEY",
  validateKey: (key: string) => /^(sk-or-|or-)[A-Za-z0-9_-]{12,}$/.test(key),
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
    const text = await openAiCompatibleComplete({
      provider: "OpenRouter",
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
    });
    return { text, provider: "openrouter", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenRouter API key is required");
    const model = request.model ?? defaultModels.openrouter;
    const text = await openAiCompatibleStream({
      provider: "OpenRouter",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      headers,
      signal: request.signal,
      onToken,
      reasoning: request.thinking,
      reasoningStyle: "openrouter",
    });
    return { text, provider: "openrouter", model };
  },
};
