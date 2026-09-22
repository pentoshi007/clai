import type { ChatMessage, CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestModelCatalogEntries,
  ProviderError,
} from "./http.js";
import {
  CLINE_API_BASE_URL,
  CLINE_REQUEST_HEADERS,
  maybeRefreshClineToken,
  type ClineOAuthTokens,
} from "./cline-auth.js";
import { getProviderKeys, replaceProviderKey } from "../store/keys.js";
import { currentSessionAffinity } from "./session-affinity.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "./cache-affinity.js";

const baseUrl = CLINE_API_BASE_URL;
const headers = CLINE_REQUEST_HEADERS;

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      "Cline authentication required. Run `clai auth cline` (browser sign-in) or add a key with `clai set cline <token>`.",
    );
  }
  return auth.apiKey;
}

function getClineHeaders(model?: string, messages?: ChatMessage[]): Record<string, string> {
  const session = currentSessionAffinity();
  const taskId = session
    ? sessionCacheAffinityKey(session)
    : messages && model
      ? cacheAffinityKey("cline", model, messages)
      : undefined;
  return {
    ...headers,
    ...(taskId ? { "X-Task-ID": taskId } : {}),
  };
}

async function withClineCredential<T>(
  auth: ProviderAuth,
  run: (key: string) => Promise<T>,
  onStatus?: ((message: string) => void) | undefined,
): Promise<T> {
  let key = requireKey(auth);
  if (
    auth.expiresAt !== undefined &&
    auth.expiresAt <= Date.now() + 60_000 &&
    auth.refreshToken
  ) {
    onStatus?.("ℹ Cline authentication expiring — refreshing token");
    const fresh = await maybeRefreshClineToken(key, auth.refreshToken);
    if (fresh?.accessToken && fresh.accessToken !== key) {
      await replaceClineKey(key, fresh).catch(() => undefined);
      key = fresh.accessToken;
      auth.apiKey = fresh.accessToken;
      if (fresh.refreshToken) auth.refreshToken = fresh.refreshToken;
      if (fresh.expiresAt !== undefined) auth.expiresAt = fresh.expiresAt;
      onStatus?.("ℹ Cline token refreshed");
    }
  }
  try {
    return await run(key);
  } catch (error) {
    const status = error instanceof ProviderError ? error.status : undefined;
    const errorMsg = error instanceof Error ? error.message : "";
    const isAuthFailure =
      status === 401 ||
      (status === 403 && /expired|invalid|unauthorized/i.test(errorMsg));
    if (!isAuthFailure) throw error;
    onStatus?.("ℹ Cline authentication expired — refreshing token");
    let refreshError = "";
    let refreshToken = auth.refreshToken;
    if (!refreshToken) {
      const allKeys = await getProviderKeys("cline").catch(() => undefined);
      const matchingSlot = allKeys?.keys.find(
        (k) =>
          k.value === key ||
          k.value === key.replace(/^workos:/, "") ||
          `workos:${k.value}` === key,
      );
      if (matchingSlot?.refreshToken) {
        refreshToken = matchingSlot.refreshToken;
      }
    }
    const fresh = await maybeRefreshClineToken(
      key,
      refreshToken,
      (message) => {
        refreshError = message;
      },
    );
    if (!fresh?.accessToken || fresh.accessToken === key) {
      const detail = refreshError ? ` (${refreshError})` : "";
      onStatus?.(
        `ℹ Cline token refresh was unavailable${detail} — trying the next provider`,
      );
      throw error;
    }
    await replaceClineKey(key, fresh).catch(() => undefined);
    auth.apiKey = fresh.accessToken;
    if (fresh.refreshToken) auth.refreshToken = fresh.refreshToken;
    if (fresh.expiresAt !== undefined) auth.expiresAt = fresh.expiresAt;
    onStatus?.("ℹ Cline token refreshed — retrying request");
    return run(fresh.accessToken);
  }
}

async function replaceClineKey(
  oldKey: string,
  fresh: ClineOAuthTokens,
): Promise<void> {
  const meta = {
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  };
  const ok = await replaceProviderKey("cline", oldKey, fresh.accessToken, meta);
  if (!ok) {
    const altKey = oldKey.startsWith("workos:")
      ? oldKey.slice(7)
      : `workos:${oldKey}`;
    await replaceProviderKey("cline", altKey, fresh.accessToken, meta).catch(() => undefined);
  }
}

export const clineProvider: LlmProvider = {
  id: "cline",
  displayName: "Cline",
  reasoningStyle: "openrouter",
  defaultModel: defaultModels.cline,
  envVar: "CLINE_API_KEY",
  validateKey: (key: string) => key.trim().length >= 20,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) {
      return cachedModels;
    }
    const reqHeaders: Record<string, string> = { ...headers };
    if (auth.apiKey) {
      reqHeaders["authorization"] = `Bearer ${auth.apiKey}`;
    }
    const response = await fetch(`${baseUrl}/ai/cline/recommended-models`, {
      headers: reqHeaders,
    });
    const payload = await readJson<{
      recommended?: unknown[];
      free?: unknown[];
      clinePass?: unknown[];
    }>(response);
    const entries = [
      ...(Array.isArray(payload.recommended) ? payload.recommended : []),
      ...(Array.isArray(payload.free) ? payload.free : []),
      ...(Array.isArray(payload.clinePass) ? payload.clinePass : []),
    ];
    const models = ingestModelCatalogEntries("cline", entries);
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const key = requireKey(auth);
    const response = await fetch(`${baseUrl}/users/me`, {
      headers: { authorization: `Bearer ${key}`, ...headers },
    });
    if (!response.ok) {
      throw new ProviderError(
        `Cline authentication failed (HTTP ${response.status}). Run \`clai auth cline\` to sign in.`,
        response.status,
      );
    }
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.cline;
    const reqHeaders = getClineHeaders(model, request.messages);
    return withClineCredential(
      auth,
      async (key) => {
        const payload = await openAiCompatibleComplete({
          provider: "Cline",
          providerId: "cline",
          baseUrl,
          apiKey: key,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          headers: reqHeaders,
          signal: request.signal,
          reasoning: request.thinking,
          reasoningStyle: "openrouter",
          tools: request.tools,
          toolChoice: request.toolChoice,
          parallelToolCalls: request.parallelToolCalls,
          unwrapDataEnvelope: true,
          reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
          ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        });
        return toCompletionResult("cline", model, payload);
      },
      onStatus,
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.cline;
    const reqHeaders = getClineHeaders(model, request.messages);
    return withClineCredential(
      auth,
      async (key) => {
        const payload = await openAiCompatibleStream({
          provider: "Cline",
          providerId: "cline",
          baseUrl,
          apiKey: key,
          model,
          messages: request.messages,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
          headers: reqHeaders,
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
        });
        return toCompletionResult("cline", model, payload);
      },
      onStatus,
    );
  },
};
