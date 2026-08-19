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

const baseUrl = "https://api.fireworks.ai/inference/v1";

export const fireworksFallbackModels = [
  "accounts/fireworks/models/kimi-k2p6",
  "accounts/fireworks/models/kimi-k2-instruct-0905",
  "accounts/fireworks/models/deepseek-v3p1",
  "accounts/fireworks/models/glm-5p2",
  "accounts/fireworks/models/qwen3-235b-a22b",
  "accounts/fireworks/models/gpt-oss-120b",
  "accounts/fireworks/models/llama4-maverick-instruct-basic",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

export const fireworksProvider: LlmProvider = {
  id: "fireworks",
  reasoningStyle: "openai",
  displayName: "Fireworks",
  defaultModel: defaultModels.fireworks,
  envVar: "FIREWORKS_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) return fireworksFallbackModels;
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { authorization: `Bearer ${auth.apiKey}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      const models = ingestOpenAiModelCatalog("fireworks", data);
      if (models.length > 0) {
        cachedModels = models;
        lastFetchTime = now;
        return models;
      }
      return fireworksFallbackModels;
    } catch {
      return fireworksFallbackModels;
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Fireworks API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Fireworks API key is required");
    const model = request.model ?? defaultModels.fireworks;
    const payload = await openAiCompatibleComplete({
      provider: "Fireworks",
      providerId: "fireworks",
      baseUrl,
      apiKey: auth.apiKey,
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      signal: request.signal,
      reasoning: request.thinking,
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("fireworks", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Fireworks API key is required");
    const model = request.model ?? defaultModels.fireworks;
    const payload = await openAiCompatibleStream({
      provider: "Fireworks",
      providerId: "fireworks",
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
      reasoningStyle: "openai",
      tools: request.tools,
      toolChoice: request.toolChoice,
      parallelToolCalls: request.parallelToolCalls,
      reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
      ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
    });
    return toCompletionResult("fireworks", model, payload);
  },
};
