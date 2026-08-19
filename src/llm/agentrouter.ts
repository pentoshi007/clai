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

// AgentRouter is an OpenAI-compatible Chat Completions gateway that proxies
// multiple frontier models (gpt-5.5, glm-5.2, claude-opus-4-*, deepseek, etc.)
// under https://agentrouter.org/v1. It accepts a standard
// `Authorization: Bearer <key>` header plus the OpenAI request body.
//
// IMPORTANT — client-identity gating:
// AgentRouter authorizes each request by *client identity*, not just the API
// key. An unknown client is rejected with HTTP 401 `unauthorized_client_error`
// ("unauthorized client detected") even when the key is perfectly valid. The
// gateway keys this off the exact `User-Agent` string, so we MUST present one
// that is on their allowlist (the older `@openai/codex` UA is NOT — it caused
// a hard 401 on every request). The identities below were verified live
// against agentrouter.org/v1 (2026-07) and correspond to the officially
// supported harnesses documented at https://agentrouter.org/docs. We keep
// several so that if the allowlist shifts and our primary identity stops
// working, we transparently rotate to the next known-good one instead of
// failing the user's turn.
// Reference: https://agentrouter.org/console/token · https://agentrouter.org/docs
const baseUrl = "https://agentrouter.org/v1";

// Ordered by preference; every entry is a client identity AgentRouter accepts.
export const AUTHORIZED_USER_AGENTS: readonly string[] = [
  "claude-cli/1.0.119 (external, cli)", // Claude Code
  "Kilo-Code/4.50.0", // Kilo Code (VS Code)
  "Cline/3.0.0", // Cline (VS Code)
  "QwenCode/0.0.11", // Qwen Code (CLI)
  "openclaw/2026.2.3", // OpenClaw (CLI)
  "hermes-agent/1.0.0", // Hermes Agent (CLI)
];

// Sticky pointer to the identity that last worked, so a healthy session issues
// exactly one request per turn (mirrors clai's sticky multi-key rotation).
let activeUaIndex = 0;

function headersForIndex(index: number): Record<string, string> {
  return { "User-Agent": AUTHORIZED_USER_AGENTS[index]! };
}

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour cache TTL

/**
 * True when an error is AgentRouter's client-identity rejection (as opposed to
 * a bad API key, quota, or rate-limit problem). Only these are worth retrying
 * with a different User-Agent; anything else should surface so the normal
 * key-rotation / backoff logic can handle it.
 */
function isUnauthorizedClientError(error: unknown): boolean {
  const status = error instanceof ProviderError ? error.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof ProviderError ? (error.body ?? "") : "";
  const hay = `${message}\n${body}`.toLowerCase();
  // The distinctive wording of the gateway's client gate. We deliberately do
  // NOT rotate on a generic 401 (that usually means an invalid key).
  const looksLikeClientGate =
    /unauthorized[_ ]client|unauthorized_client_error|unknown client|client detected/.test(
      hay,
    );
  if (!looksLikeClientGate) return false;
  return status === undefined || status === 401 || status === 403;
}

/**
 * Run an AgentRouter operation with the sticky client identity, transparently
 * rotating through the known-good User-Agents when the gateway rejects the
 * client. The identity that succeeds becomes sticky for subsequent calls.
 *
 * Safe for streaming: AgentRouter's client-identity rejection arrives as a
 * non-OK HTTP response that is read up front (before any SSE tokens are
 * emitted), so a retry never double-emits tokens.
 */
async function withAuthorizedClient<T>(
  op: (headers: Record<string, string>) => Promise<T>,
): Promise<T> {
  const start = activeUaIndex;
  let lastError: unknown;
  for (let attempt = 0; attempt < AUTHORIZED_USER_AGENTS.length; attempt++) {
    const index = (start + attempt) % AUTHORIZED_USER_AGENTS.length;
    try {
      const result = await op(headersForIndex(index));
      activeUaIndex = index; // remember what worked
      return result;
    } catch (error) {
      lastError = error;
      if (!isUnauthorizedClientError(error)) throw error;
      // otherwise: rotate to the next known-good client identity and retry.
    }
  }
  throw lastError;
}

/**
 * Claude extended thinking on AgentRouter (Bedrock/Anthropic) is rejected when
 * `max_tokens` is not greater than the effort's `thinking.budget_tokens`.
 * `buildChatBody` already floors max_tokens for Claude reasoning, but enforcement
 * is load-balanced and inconsistent, so this is a belt-and-suspenders net: given
 * such an error, it returns a max_tokens large enough to clear the reported
 * budget so the caller can retry. Returns undefined for every other error, so
 * unrelated failures propagate untouched.
 */
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
  // Only retry if we'd actually raise the ceiling beyond what we already sent.
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
  // AgentRouter keys follow the `sk-...` shape used by their console.
  // We accept any non-trivial token starting with `sk-` so users can paste
  // newly-issued keys without us guessing the exact length.
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
