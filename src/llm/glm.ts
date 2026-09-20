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
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
} from "./http.js";

const baseUrl = "https://api.z.ai/api/paas/v4";

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

export const glmProvider: LlmProvider = {
  id: "glm",
  reasoningStyle: "openai",
  displayName: "GLM",
  defaultModel: defaultModels.glm,
  envVar: "GLM_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9._-]{16,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("GLM API key is required");
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
    const models = ingestOpenAiModelCatalog("glm", data);
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("GLM API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("GLM API key is required");
    const model = request.model ?? defaultModels.glm;
    const payload = await openAiCompatibleComplete({
      responsesFirst: false,
      provider: "GLM",
      providerId: "glm",
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
    return toCompletionResult("glm", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("GLM API key is required");
    const model = request.model ?? defaultModels.glm;
    const payload = await openAiCompatibleStream({
      responsesFirst: false,
      provider: "GLM",
      providerId: "glm",
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
    return toCompletionResult("glm", model, payload);
  },
};
