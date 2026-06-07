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

// Kimchi exposes an OpenAI-compatible Chat Completions API at
// https://llm.kimchi.dev/openai/v1. API keys are alphanumeric.
const baseUrl = "https://llm.kimchi.dev/openai/v1";

export const kimchiProvider: LlmProvider = {
  id: "kimchi",
  displayName: "Kimchi",
  defaultModel: defaultModels.kimchi,
  envVar: "CASTAI_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_-]{8,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Kimchi API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Kimchi API key is required");
    const model = request.model ?? defaultModels.kimchi;
    const text = await openAiCompatibleComplete({
      provider: "Kimchi",
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
    return { text, provider: "kimchi", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Kimchi API key is required");
    const model = request.model ?? defaultModels.kimchi;
    const text = await openAiCompatibleStream({
      provider: "Kimchi",
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
    return { text, provider: "kimchi", model };
  },
};
