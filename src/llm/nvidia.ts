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

// NVIDIA NIM exposes an OpenAI-compatible Chat Completions API at
// https://integrate.api.nvidia.com/v1. API keys are prefixed `nvapi-`.
// Reference: https://docs.api.nvidia.com/nim/reference/llm-apis
const baseUrl = "https://integrate.api.nvidia.com/v1";

export const nvidiaFallbackModels = [
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
  "moonshotai/kimi-k2.6",
  "deepseek-ai/deepseek-v4-flash",
  "deepseek-ai/deepseek-v4-pro",
  "z-ai/glm-5.1",
  "minimaxai/minimax-m2.7",
  "minimaxai/minimax-m3",
  "google/gemma-4-31b-it",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/llama-3.3-nemotron-super-49b-v1",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "meta/llama-3.3-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "meta/llama-3.1-70b-instruct",
  "nvidia/llama-3.1-nemotron-70b-instruct",
  "mistralai/mistral-nemotron",
  "qwen/qwen3-coder-480b-a35b-instruct",
  "qwen/qwen3-next-80b-a3b-instruct",
  "qwen/qwen3.5-122b-a10b",
  "moonshotai/kimi-k2-instruct",
  "moonshotai/kimi-k2-thinking",
  "mistralai/mistral-small-4-119b-2603",
  "mistralai/mistral-medium-3.5-128b",
  "mistralai/mistral-large-3-675b-instruct-2512",
  "stepfun-ai/step-3.5-flash",
  "stepfun-ai/step-3.7-flash",
  "sarvamai/sarvam-m",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

export const nvidiaProvider: LlmProvider = {
  id: "nvidia",
  displayName: "NVIDIA NIM",
  defaultModel: defaultModels.nvidia,
  envVar: "NVIDIA_API_KEY",
  validateKey: (key: string) => /^nvapi-[A-Za-z0-9_-]{16,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) {
      return nvidiaFallbackModels;
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
      return nvidiaFallbackModels;
    } catch {
      return nvidiaFallbackModels;
    }
  },
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
      reasoning: request.thinking,
      reasoningStyle: "nvidia",
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
      reasoning: request.thinking,
      reasoningStyle: "nvidia",
      // NIM queues/cold starts and the large agent prompt can take longer
      // than 45s before the first SSE byte. After the first byte, retain a
      // short watchdog so a genuinely wedged stream is still cancellable.
      initialIdleTimeoutMs: 90_000,
      idleTimeoutMs: 30_000,
    });
    return { text, provider: "nvidia", model };
  },
};
