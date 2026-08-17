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
  ProviderError,
  type ReasoningStyle,
} from "./http.js";
import { withEffortFallback } from "./effort-fallback.js";

const baseUrl = "https://router.bynara.id/v1";

const BYNARA_REASONING_STYLE: ReasoningStyle = "bynara";

interface ModelCache {
  models: string[];
  fetchedAt: number;
}
const modelCache = new Map<string, ModelCache>();
const CACHE_TTL_MS = 60 * 60 * 1000;

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
    let attemptIndex = 0;
    return await withEffortFallback(
      request,
      async (thinking) =>
        runGenerationAttempt(
          request,
          {
            provider: "bynara",
            model,
            mode: "complete",
            reason:
              attemptIndex++ === 0
                ? (request.attemptReason ?? "initial")
                : "provider-retry",
          },
          async () => {
            const payload = await openAiCompatibleComplete({
              provider: "Bynara",
              providerId: "bynara",
              baseUrl,
              apiKey,
              model,
              messages: request.messages,
              maxTokens: request.maxTokens,
              temperature: request.temperature,
              signal: request.signal,
              reasoning: thinking,
              reasoningStyle: BYNARA_REASONING_STYLE,
              tools: request.tools,
              toolChoice: request.toolChoice,
              parallelToolCalls: request.parallelToolCalls,
              reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
            });
            return toCompletionResult("bynara", model, payload);
          },
        ),
      () => {
        throw new ProviderError(
          `Bynara returned no completion text (model=${model}).`,
        );
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
    let attemptIndex = 0;
    return await withEffortFallback(
      request,
      async (thinking) =>
        runGenerationAttempt(
          request,
          {
            provider: "bynara",
            model,
            mode: "stream",
            reason:
              attemptIndex++ === 0
                ? (request.attemptReason ?? "initial")
                : "provider-retry",
          },
          async () => {
            const budgets = streamIdleBudgets(Boolean(thinking?.enabled));
            const payload = await openAiCompatibleStream({
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
              reasoning: thinking,
              reasoningStyle: BYNARA_REASONING_STYLE,
              idleTimeoutMs: budgets.idleTimeoutMs,
              initialIdleTimeoutMs: thinking?.enabled
                ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
                : 60_000,
              outputIdleTimeoutMs: budgets.outputIdleTimeoutMs,
              tools: request.tools,
              toolChoice: request.toolChoice,
              parallelToolCalls: request.parallelToolCalls,
              reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
            });
            return toCompletionResult("bynara", model, payload);
          },
        ),
      () => {
        throw new ProviderError(`Bynara stream failed (model=${model}).`);
      },
    );
  },
};
