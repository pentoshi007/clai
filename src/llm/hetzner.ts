import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  ingestOpenAiModelCatalog,
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  readJson,
  toCompletionResult,
} from "./http.js";

const baseUrl = "https://inference.hetzner.com/api/v1";

export const hetznerFallbackModels = [
  "Qwen/Qwen3.6-35B-A3B-FP8",
  "Qwen/Qwen3.6-35B-A3B",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const hetznerProvider: LlmProvider = {
  id: "hetzner",
  reasoningStyle: "stepfun",
  displayName: "Hetzner",
  defaultModel: defaultModels.hetzner,
  envVar: "HETZNER_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) return hetznerFallbackModels;
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${auth.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      const models = ingestOpenAiModelCatalog("hetzner", data);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return hetznerFallbackModels;
    } catch {
      return hetznerFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Hetzner API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Hetzner API key is required");
    const model = request.model ?? defaultModels.hetzner;
    const payload = await openAiCompatibleComplete({
      provider: "Hetzner",
      providerId: "hetzner",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "stepfun",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("hetzner", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Hetzner API key is required");
    const model = request.model ?? defaultModels.hetzner;
    const payload = await openAiCompatibleStream({
      provider: "Hetzner",
      providerId: "hetzner",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
      reasoning: request.thinking,
      reasoningStyle: "stepfun",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
    });
    return toCompletionResult("hetzner", model, payload);
  },
};
