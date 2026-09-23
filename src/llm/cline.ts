import type { CompletionRequest, CompletionResult } from "../types.js";
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
  ClineAuthError,
  getClineRefreshToken,
  refreshClineToken,
  type ClineOAuthTokens,
} from "./cline-auth.js";
import { getProviderKeys, replaceProviderKey } from "../store/keys.js";
import { currentSessionAffinity } from "./session-affinity.js";

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

function getClineHeaders(): Record<string, string> {
  return {
    ...headers,
    "X-Task-ID": currentSessionAffinity() ?? "",
  };
}

const CLINE_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const CLINE_REFRESH_GRACE_MS = 30 * 1000;

class ClineCredentialStoreError extends Error {}

function matchesClineKey(storedKey: string, currentKey: string): boolean {
  return storedKey.replace(/^workos:/i, "") === currentKey.replace(/^workos:/i, "");
}

function isClineAuthFailure(error: unknown): boolean {
  const status = error instanceof ProviderError ? error.status : undefined;
  const message = error instanceof Error ? error.message : "";
  return status === 401 || (status === 403 && /expired|invalid|unauthorized/i.test(message));
}

async function findClineRefreshToken(
  currentKey: string,
  auth: ProviderAuth,
): Promise<string | undefined> {
  if (auth.refreshToken) return auth.refreshToken;
  const keys = await getProviderKeys("cline").catch(() => undefined);
  const slot = keys?.keys.find((candidate) => matchesClineKey(candidate.value, currentKey));
  if (slot?.refreshToken) return slot.refreshToken;
  return getClineRefreshToken(currentKey);
}

async function replaceClineKey(oldKey: string, fresh: ClineOAuthTokens): Promise<void> {
  const metadata = {
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  };
  const alternateKey = oldKey.startsWith("workos:")
    ? oldKey.slice(7)
    : `workos:${oldKey}`;
  try {
    if (await replaceProviderKey("cline", oldKey, fresh.accessToken, metadata)) return;
    if (await replaceProviderKey("cline", alternateKey, fresh.accessToken, metadata)) return;
    const keys = await getProviderKeys("cline");
    if (keys.keys.some((key) => key.value === fresh.accessToken && key.refreshToken === fresh.refreshToken)) {
      return;
    }
  } catch {
    throw new ClineCredentialStoreError(
      "Cline refreshed its credentials, but clai could not save the rotated tokens.",
    );
  }
  throw new ClineCredentialStoreError(
    "Cline refreshed its credentials, but the matching clai account could not be found to save them.",
  );
}

const credentialRefreshesInFlight = new Map<string, Promise<ClineOAuthTokens>>();

async function refreshAndPersistClineCredential(
  key: string,
  auth: ProviderAuth,
  refreshToken: string,
): Promise<ClineOAuthTokens> {
  const inFlight = credentialRefreshesInFlight.get(refreshToken);
  if (inFlight) {
    const fresh = await inFlight;
    auth.apiKey = fresh.accessToken;
    auth.refreshToken = fresh.refreshToken;
    auth.expiresAt = fresh.expiresAt;
    return fresh;
  }
  const refresh = (async () => {
    const fresh = await refreshClineToken(refreshToken);
    auth.apiKey = fresh.accessToken;
    auth.refreshToken = fresh.refreshToken;
    auth.expiresAt = fresh.expiresAt;
    await replaceClineKey(key, fresh);
    return fresh;
  })();
  credentialRefreshesInFlight.set(refreshToken, refresh);
  try {
    return await refresh;
  } finally {
    if (credentialRefreshesInFlight.get(refreshToken) === refresh) {
      credentialRefreshesInFlight.delete(refreshToken);
    }
  }
}

async function refreshClineBeforeRequest(
  key: string,
  auth: ProviderAuth,
  refreshToken: string | undefined,
  onStatus?: ((message: string) => void) | undefined,
): Promise<string> {
  const expiresAt = auth.expiresAt;
  if (!refreshToken) {
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      throw new ProviderError("Cline access token expired and no refresh token is available; sign in again.", 401);
    }
    return key;
  }
  if (expiresAt !== undefined && expiresAt > Date.now() + CLINE_REFRESH_BUFFER_MS) return key;
  onStatus?.("ℹ Cline authentication expiring — refreshing token");
  try {
    const fresh = await refreshAndPersistClineCredential(key, auth, refreshToken);
    onStatus?.("ℹ Cline token refreshed");
    return fresh.accessToken;
  } catch (error) {
    if (error instanceof ClineCredentialStoreError) throw error;
    if (error instanceof ClineAuthError && error.isLikelyInvalidGrant()) throw error;
    if (expiresAt !== undefined && expiresAt - Date.now() > CLINE_REFRESH_GRACE_MS) {
      onStatus?.("ℹ Cline refresh temporarily failed; using the current token until it expires");
      return key;
    }
    throw error;
  }
}

async function withClineCredential<T>(
  auth: ProviderAuth,
  run: (key: string) => Promise<T>,
  onStatus?: ((message: string) => void) | undefined,
): Promise<T> {
  let key = requireKey(auth);
  let refreshToken = await findClineRefreshToken(key, auth);
  key = await refreshClineBeforeRequest(key, auth, refreshToken, onStatus);
  refreshToken = auth.refreshToken ?? refreshToken;
  try {
    return await run(key);
  } catch (error) {
    if (!isClineAuthFailure(error)) throw error;
    if (!refreshToken) throw error;
    onStatus?.("ℹ Cline authentication rejected — refreshing token");
    const fresh = await refreshAndPersistClineCredential(key, auth, refreshToken);
    onStatus?.("ℹ Cline token refreshed — retrying request");
    return run(fresh.accessToken);
  }
}

async function fetchClineModels(apiKey?: string): Promise<string[]> {
  const reqHeaders = {
    ...getClineHeaders(),
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  };
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
  return ingestModelCatalogEntries("cline", entries);
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
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    const models = auth.apiKey
      ? await withClineCredential(auth, fetchClineModels)
      : await fetchClineModels();
    if (models.length > 0) {
      cachedModels = models;
      lastFetchTime = now;
    }
    return models;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    await withClineCredential(auth, async (key) => {
      const response = await fetch(`${baseUrl}/users/me`, {
        headers: { ...getClineHeaders(), authorization: `Bearer ${key}` },
      });
      if (!response.ok) {
        throw new ProviderError(
          `Cline authentication failed (HTTP ${response.status}). Run \`clai auth cline\` to sign in.`,
          response.status,
        );
      }
    });
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.cline;
    const reqHeaders = getClineHeaders();
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
    const reqHeaders = getClineHeaders();
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
