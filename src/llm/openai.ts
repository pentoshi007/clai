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

const baseUrl = "https://api.openai.com/v1";

export const openaiProvider: LlmProvider = {
  id: "openai",
  displayName: "OpenAI",
  defaultModel: defaultModels.openai,
  envVar: "OPENAI_API_KEY",
  validateKey: (key: string) => /^sk-[A-Za-z0-9_-]{12,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("OpenAI API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenAI API key is required");
    const model = request.model ?? defaultModels.openai;
    const text = await openAiCompatibleComplete({
      provider: "OpenAI",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
    });
    return { text, provider: "openai", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenAI API key is required");
    const model = request.model ?? defaultModels.openai;
    const text = await openAiCompatibleStream({
      provider: "OpenAI",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
    });
    return { text, provider: "openai", model };
  },
};
