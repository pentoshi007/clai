import type { CompletionRequest, CompletionResult } from "../types.js";
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
  ProviderError,
  ingestOpenAiModelCatalog,
} from "./http.js";

const baseUrl = "https://agentrouter.org/v1";

export const AUTHORIZED_USER_AGENTS: readonly string[] = [
  "claude-cli/1.0.119 (external, cli)",
  "Kilo-Code/4.50.0",
  "Cline/3.0.0",
  "QwenCode/0.0.11",
  "openclaw/2026.2.3",
  "hermes-agent/1.0.0",
];

let activeUaIndex = 0;

function headersForIndex(index: number): Record<string, string> {
  return { "User-Agent": AUTHORIZED_USER_AGENTS[index]! };
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000;

function isUnauthorizedClientError(error: unknown): boolean {
  const status = error instanceof ProviderError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof ProviderError ? (error.body ?? "") : "";
  const hay = `${message}\n${body}`.toLowerCase();
  const looksLikeClientGate =
    /unauthorized[_ ]client|unauthorized_client_error|unknown client|client detected/.test(
      hay,
    );
  if (!looksLikeClientGate) return false;
  return status === undefined || status === 401 || status === 403;
}

async function withAuthorizedClient<T>(
  op: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const start = activeUaIndex;
  let lastError: unknown;
  for (let attempt = 0; attempt < AUTHORIZED_USER_AGENTS.length; attempt++) {
    const index = (start + attempt) % AUTHORIZED_USER_AGENTS.length;
    try {
      const result = await op(headersForIndex(index));
      activeUaIndex = index;
      return result;
    } catch (error) {
      lastError = error;
      if (!isUnauthorizedClientError(error)) throw error;
    }
  }
  throw lastError;
}

export function bumpMaxTokensForThinkingBudget(
  error: unknown,
  currentMaxTokens: number | undefined,
): number | undefined {
  if (!(error instanceof ProviderError)) return undefined;
  const hay = `${error.message}\n${error.body ?? ""}`;
  if (!/budget_tokens/i.test(hay) || !/max_tokens/i.test(hay)) return undefined;
  const match = hay.match(/budget_tokens\D*(\d+)/i);
  const budget = match ? Number(match[1]) : Number.NaN;
  const target = Number.isFinite(budget)
    ? Math.max(budget + 8_192, 32_000)
    : 40_000;
  if (currentMaxTokens !== undefined && currentMaxTokens >= target) {
    return undefined;
  }
  return target;
}

export const agentrouterProvider: LlmProvider = {
  id: "agentrouter",
  reasoningStyle: "agentrouter",
  displayName: "AgentRouter",
  defaultModel: defaultModels.agentrouter,
  envVar: "AGENTROUTER_API_KEY",
  validateKey: (key: string) => /^sk-[A-Za-z0-9_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const apiKey = auth.apiKey;
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const models = await withAuthorizedClient(async (headers) => {
      const response = await fetch(`${baseUrl}/models`, {
        headers: {
          authorization: `Bearer ${apiKey}`,
          ...headers,
        },
      });
      const data = await readJson<{ data?: Array<{ id: string }> }>(response);
      return ingestOpenAiModelCatalog("agentrouter", data);
    });
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const apiKey = auth.apiKey;
    await withAuthorizedClient((headers) =>
      openAiCompatiblePing(baseUrl, apiKey, headers),
    );
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const apiKey = auth.apiKey;
    const model = request.model ?? defaultModels.agentrouter;
    let attemptIndex = 0;
    const invoke = (maxTokens: number | undefined) =>
      withAuthorizedClient((headers) =>
        runGenerationAttempt(
          request,
          {
            provider: "agentrouter",
            model,
            mode: "complete",
            reason:
              attemptIndex++ === 0
                ? (request.attemptReason ?? "initial")
                : "provider-retry",
          },
          async () => {
            const payload = await openAiCompatibleComplete({
              provider: "AgentRouter",
              providerId: "agentrouter",
              baseUrl,
              apiKey,
              model,
              messages: request.messages,
              maxTokens,
              temperature: request.temperature,
              signal: request.signal,
              reasoning: request.thinking,
              reasoningStyle: "agentrouter",
              headers,
              tools: request.tools,
              toolChoice: request.toolChoice,
              parallelToolCalls: request.parallelToolCalls,
              reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
              ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
            });
            return toCompletionResult("agentrouter", model, payload);
          },
        ),
      );
    let result: CompletionResult;
    try {
      result = await invoke(request.maxTokens);
    } catch (error) {
      const bumped = bumpMaxTokensForThinkingBudget(error, request.maxTokens);
      if (bumped === undefined) throw error;
      result = await invoke(bumped);
    }
    return result;
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("AgentRouter API key is required");
    const apiKey = auth.apiKey;
    const model = request.model ?? defaultModels.agentrouter;
    let attemptIndex = 0;
    const invoke = (maxTokens: number | undefined) =>
      withAuthorizedClient((headers) =>
        runGenerationAttempt(
          request,
          {
            provider: "agentrouter",
            model,
            mode: "stream",
            reason:
              attemptIndex++ === 0
                ? (request.attemptReason ?? "initial")
                : "provider-retry",
          },
          async () => {
            const payload = await openAiCompatibleStream({
              provider: "AgentRouter",
              providerId: "agentrouter",
              baseUrl,
              apiKey,
              model,
              messages: request.messages,
              maxTokens,
              temperature: request.temperature,
              signal: request.signal,
              onToken,
              onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
              reasoning: request.thinking,
              reasoningStyle: "agentrouter",
              initialIdleTimeoutMs: 60_000,
              headers,
              tools: request.tools,
              toolChoice: request.toolChoice,
              parallelToolCalls: request.parallelToolCalls,
              reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
              ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
            });
            return toCompletionResult("agentrouter", model, payload);
          },
        ),
      );
    let result: CompletionResult;
    try {
      result = await invoke(request.maxTokens);
    } catch (error) {
      const bumped = bumpMaxTokensForThinkingBudget(error, request.maxTokens);
      if (bumped === undefined) throw error;
      result = await invoke(bumped);
    }
    return result;
  },
};
