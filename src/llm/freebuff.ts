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
} from "./http.js";
import { FREEBUFF_API_BASE_URL } from "./freebuff-auth.js";
import { fetchFreebuffModelIds, freebuffStaticModelIds } from "./freebuff-models.js";
import { freebuffSessionManager } from "./freebuff-session.js";
import { finishFreebuffRun, startFreebuffRun } from "./freebuff-run.js";

const CHAT_BASE_URL = `${FREEBUFF_API_BASE_URL}/api/v1`;
const CLIENT_USER_AGENT = "ai-sdk/openai-compatible/7.0.59/codebuff";
const CLAI_USER_AGENT = "clai/1.0 (+https://github.com/clai/clai)";

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey || auth.apiKey.trim().length < 8) {
    throw new Error(
      "Freebuff authentication required. Run `clai auth freebuff` to sign in (browser or headless), or set FREEBUFF_API_KEY.",
    );
  }
  return auth.apiKey.trim();
}

function requestHeaders(token: string, run?: { readonly instanceId?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "user-agent": `${CLIENT_USER_AGENT} ${CLAI_USER_AGENT}`,
    accept: "text/event-stream",
  };
  if (run?.instanceId) {
    headers["x-freebuff-instance-id"] = run.instanceId;
  }
  try {
    headers["x-fb-timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
  }
  return headers;
}

interface RunScope {
  readonly bodyExtras: Readonly<Record<string, unknown>>;
  readonly finish: (status: "completed" | "failed" | "cancelled", steps: number) => Promise<void>;
}

/**
 * The backend rejects a completion whose `codebuff_metadata.run_id` names no
 * registered run, so every call opens one. The session claim is separate: the
 * completions endpoint does not require it, so admission is best-effort and a
 * refusal degrades to an unclaimed run rather than failing the request.
 */
async function withRun<T>(
  token: string,
  model: string,
  signal: AbortSignal | undefined,
  body: (scope: RunScope) => Promise<T>,
): Promise<T> {
  const manager = freebuffSessionManager();
  const admission = await manager
    .ensureAdmission(token, model, signal)
    .catch(() => undefined);
  const run = await startFreebuffRun(token, model, { ...(signal ? { signal } : {}) });
  let steps = 0;
  const scope: RunScope = {
    bodyExtras: {
      codebuff_metadata: {
        run_id: run.runId,
        client_id: run.clientId,
        ...admission?.metadata,
      },
      provider: { allow_fallbacks: true },
    },
    finish: async (status, count) => {
      steps = count;
      await finishFreebuffRun(token, run, status, steps, signal ? { signal } : {});
    },
  };
  try {
    return await body(scope);
  } catch (error) {
    await scope.finish("failed", steps);
    throw error;
  } finally {
    if (admission) {
      await manager.release(token, model).catch(() => undefined);
    }
  }
}

export const freebuffProvider: LlmProvider = {
  id: "freebuff",
  displayName: "Freebuff",
  reasoningStyle: "openrouter",
  defaultModel: defaultModels.freebuff,
  envVar: "FREEBUFF_API_KEY",
  validateKey: (key: string) => key.trim().length >= 8,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) return freebuffStaticModelIds();
    return fetchFreebuffModelIds(auth.apiKey);
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const token = requireKey(auth);
    await openAiCompatiblePing(CHAT_BASE_URL, token, requestHeaders(token));
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const token = requireKey(auth);
    const model = request.model ?? defaultModels.freebuff;
    const payload = await withRun(token, model, request.signal, (scope) =>
      openAiCompatibleComplete({
        provider: "Freebuff",
        providerId: "freebuff",
        baseUrl: CHAT_BASE_URL,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        headers: requestHeaders(token),
        bodyExtras: scope.bodyExtras,
        signal: request.signal,
        reasoning: request.thinking,
        reasoningStyle: "openrouter",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      }).then(async (result) => {
        await scope.finish("completed", 1);
        return result;
      }),
    );
    return toCompletionResult("freebuff", model, payload);
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    const token = requireKey(auth);
    const model = request.model ?? defaultModels.freebuff;
    const headers = requestHeaders(token);
    const payload = await withRun(token, model, request.signal, (scope) =>
      openAiCompatibleStream({
        provider: "Freebuff",
        providerId: "freebuff",
        baseUrl: CHAT_BASE_URL,
        apiKey: token,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        headers,
        bodyExtras: scope.bodyExtras,
        includeStreamUsage: true,
        signal: request.signal,
        onToken,
        onToolCallDelta: request.onToolCallDelta,
        onStreamEvent: request.onStreamEvent,
        reasoning: request.thinking,
        reasoningStyle: "openrouter",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      }).then(async (result) => {
        await scope.finish("completed", 1);
        return result;
      }),
    );
    return toCompletionResult("freebuff", model, payload);
  },
};
