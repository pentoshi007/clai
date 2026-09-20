import type {
  CompletionRequest,
  CompletionResult,
} from "../types.js";
import { runGenerationAttempt } from "./operation-usage.js";
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
  streamIdleBudgets,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  type ReasoningStyle,
} from "./http.js";

const baseUrl = "https://router.bynara.id/v1";

const BYNARA_REASONING_STYLE: ReasoningStyle = "bynara";

interface ModelCache {
  models: string[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export const bynaraProvider: LlmProvider = {
  id: "bynara",
  reasoningStyle: "bynara",
  displayName: "Bynara",
  defaultModel: defaultModels.bynara,
  envVar: "BYNARA_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const key = auth.apiKey ?? "";
    const now = Date.now();
    const cached = modelCache.get(key);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const resp = await fetch(`${baseUrl}/models`, {
        headers: key ? { authorization: `Bearer ${key}` } : {},
      });
      const data = await readJson<{ data?: Array<{ id: string }> }>(resp);
      const models = ingestOpenAiModelCatalog("bynara", data);
      if (models.length > 0) {
        modelCache.set(key, { models, fetchedAt: now });
      }
      return models;
    } catch {
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Bynara API key is required");
    await openAiCompatiblePing(baseUrl, auth.apiKey);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey;
    if (!apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    return await runGenerationAttempt(
      request,
      {
        provider: "bynara",
        model,
        mode: "complete",
        reason: request.attemptReason ?? "initial",
      },
      async () => {
        const payload = await openAiCompatibleComplete({
          responsesFirst: true,
          provider: "Bynara",
          providerId: "bynara",
          baseUrl,
          apiKey,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          signal: request.signal,
          reasoning: request.thinking,
          reasoningStyle: BYNARA_REASONING_STYLE,
          tools: request.tools,
          toolChoice: request.toolChoice,
          parallelToolCalls: request.parallelToolCalls,
          reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
          ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        });
        return toCompletionResult("bynara", model, payload);
      },
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const apiKey = auth.apiKey;
    if (!apiKey) throw new Error("Bynara API key is required");
    const model = request.model ?? defaultModels.bynara;
    return await runGenerationAttempt(
      request,
      {
        provider: "bynara",
        model,
        mode: "stream",
        reason: request.attemptReason ?? "initial",
      },
      async () => {
        const budgets = streamIdleBudgets(Boolean(request.thinking?.enabled));
        const payload = await openAiCompatibleStream({
          responsesFirst: true,
          provider: "Bynara",
          providerId: "bynara",
          baseUrl,
          apiKey,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          signal: request.signal,
          onToken,
          onToolCallDelta: request.onToolCallDelta,
          onStreamEvent: request.onStreamEvent,
          reasoning: request.thinking,
          reasoningStyle: BYNARA_REASONING_STYLE,
          idleTimeoutMs: budgets.idleTimeoutMs,
          initialIdleTimeoutMs: request.thinking?.enabled
            ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
            : 60_000,
          outputIdleTimeoutMs: budgets.outputIdleTimeoutMs,
          tools: request.tools,
          toolChoice: request.toolChoice,
          parallelToolCalls: request.parallelToolCalls,
          reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
          ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        });
        return toCompletionResult("bynara", model, payload);
      },
    );
  },
};
