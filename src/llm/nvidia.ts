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

// NVIDIA NIM exposes an OpenAI-compatible Chat Completions API at
// https://integrate.api.nvidia.com/v1. API keys are prefixed `nvapi-`.
// Reference: https://docs.api.nvidia.com/nim/reference/llm-apis
const baseUrl = "https://integrate.api.nvidia.com/v1";

export const nvidiaProvider: LlmProvider = {
  id: "nvidia",
  displayName: "NVIDIA NIM",
  defaultModel: defaultModels.nvidia,
  envVar: "NVIDIA_API_KEY",
  validateKey: (key: string) => /^nvapi-[A-Za-z0-9_-]{16,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("NVIDIA NIM API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("NVIDIA NIM API key is required");
    const model = request.model ?? defaultModels.nvidia;
    const text = await openAiCompatibleComplete({
      provider: "NVIDIA NIM",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
    });
    return { text, provider: "nvidia", model };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("NVIDIA NIM API key is required");
    const model = request.model ?? defaultModels.nvidia;
    const text = await openAiCompatibleStream({
      provider: "NVIDIA NIM",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
    });
    return { text, provider: "nvidia", model };
  },
};
