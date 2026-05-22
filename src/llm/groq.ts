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

const baseUrl = "https://api.groq.com/openai/v1";

export const groqProvider: LlmProvider = {
  id: "groq",
  displayName: "Groq",
  defaultModel: defaultModels.groq,
  envVar: "GROQ_API_KEY",
  validateKey: (key: string) => /^gsk_[A-Za-z0-9_-]{8,}$/.test(key),
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
      maxTokens: request.maxTokens,
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
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      reasoning: request.thinking,
      reasoningStyle: "groq",
    });
    return { text, provider: "groq", model };
  },
};
