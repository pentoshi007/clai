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

const baseUrl = "https://api.openai.com/v1";

export const openaiProvider: LlmProvider = {
  id: "openai",
  reasoningStyle: "openai",
  displayName: "OpenAI",
  defaultModel: defaultModels.openai,
  envVar: "OPENAI_API_KEY",
  validateKey: (key: string) => /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{12,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("OpenAI API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    const data = await readJson<{ data?: Array<{ id: string }> }>(response);
    return ingestOpenAiModelCatalog("openai", data);
  },
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
    const payload = await openAiCompatibleComplete({
      provider: "OpenAI",
      providerId: "openai",
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
    return toCompletionResult("openai", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("OpenAI API key is required");
    const model = request.model ?? defaultModels.openai;
    const payload = await openAiCompatibleStream({
      provider: "OpenAI",
      providerId: "openai",
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
    return toCompletionResult("openai", model, payload);
  },
};

