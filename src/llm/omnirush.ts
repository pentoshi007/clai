import type { CompletionRequest, CompletionResult } from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import { ingestOpenAiModelCatalog, ProviderError, readJson } from "./http.js";
import { META_STREAM_TERMINAL } from "./stream-terminal.js";
import {
  mapResponsesEffort,
  responsesStream,
  type ResponsesDialectConfig,
} from "./responses-dialect.js";
import {
  importExistingOmnirushAuth,
  omnirushGatewayUrl,
  omnirushGatewayUserAgent,
  refreshOmnirushToken,
} from "./omnirush-auth.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "./cache-affinity.js";
import { currentSessionAffinity } from "./session-affinity.js";
import { getProviderKeys, replaceProviderKey } from "../store/keys.js";

export const omnirushFallbackModels: readonly string[] = [
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-5.6-sol",
  "meta-muse-spark",
  "muse-spark-1.1",
  "muse-spark-1.3",
  "muse-spark-1.2-contributor",
];

let cachedModels: string[] | null = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

export function resetOmnirushModelCache(): void {
  cachedModels = null;
  lastFetchTime = 0;
}

function requireKey(auth: ProviderAuth): string {
  if (!auth.apiKey) {
    throw new Error(
      "Omnirush authentication required. Run `clai auth omnirush` to sign in with the browser device flow, or `clai auth omnirush --import` to reuse the omnirush CLI login.",
    );
  }
  return auth.apiKey;
}

function gatewayBase(auth: ProviderAuth): string {
  const override = auth.baseUrl?.trim();
  if (override) {
    const clean = override.replace(/\/+$/, "");
    return /\/v1$/i.test(clean) ? clean : `${clean}/v1`;
  }
  return omnirushGatewayUrl();
}

function gatewayHeaders(apiKey: string, accept: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    accept,
    "user-agent": omnirushGatewayUserAgent(),
  };
}

function isOmnirushAuthFailure(error: unknown): boolean {
  const status = error instanceof ProviderError ? error.status : undefined;
  const message = error instanceof Error ? error.message : "";
  return (
    status === 401 ||
    (status === 403 && /expired|invalid|unauthorized|not allowed|denied/i.test(message))
  );
}

async function findOmnirushRefreshToken(
  currentKey: string,
  auth: ProviderAuth,
): Promise<string | undefined> {
  if (auth.refreshToken) return auth.refreshToken;
  const keys = await getProviderKeys("omnirush").catch(() => undefined);
  const slot = keys?.keys.find((candidate) => candidate.value === currentKey);
  if (slot?.refreshToken) return slot.refreshToken;
  const imported = await importExistingOmnirushAuth().catch(() => undefined);
  if (imported && imported.accessToken === currentKey) return imported.refreshToken;
  return undefined;
}

async function replaceOmnirushKey(
  oldKey: string,
  fresh: { accessToken: string; refreshToken: string },
): Promise<void> {
  const metadata = { refreshToken: fresh.refreshToken };
  try {
    if (await replaceProviderKey("omnirush", oldKey, fresh.accessToken, metadata)) return;
    const keys = await getProviderKeys("omnirush");
    if (
      keys.keys.some(
        (key) =>
          key.value === fresh.accessToken && key.refreshToken === fresh.refreshToken,
      )
    ) {
      return;
    }
  } catch {
    throw new Error(
      "Omnirush refreshed its credentials, but clai could not save the rotated tokens.",
    );
  }
  throw new Error(
    "Omnirush refreshed its credentials, but the matching clai account could not be found to save them.",
  );
}

const refreshesInFlight = new Map<
  string,
  Promise<{ accessToken: string; refreshToken: string }>
>();

async function refreshAndPersistOmnirushCredential(
  key: string,
  auth: ProviderAuth,
  refreshToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const inFlight = refreshesInFlight.get(refreshToken);
  if (inFlight) {
    const fresh = await inFlight;
    auth.apiKey = fresh.accessToken;
    auth.refreshToken = fresh.refreshToken;
    return fresh;
  }
  const refresh = (async () => {
    const fresh = await refreshOmnirushToken(refreshToken);
    auth.apiKey = fresh.accessToken;
    auth.refreshToken = fresh.refreshToken;
    await replaceOmnirushKey(key, fresh);
    return fresh;
  })();
  refreshesInFlight.set(refreshToken, refresh);
  try {
    return await refresh;
  } finally {
    if (refreshesInFlight.get(refreshToken) === refresh) {
      refreshesInFlight.delete(refreshToken);
    }
  }
}

async function withOmnirushCredential<T>(
  auth: ProviderAuth,
  run: (key: string) => Promise<T>,
  onStatus?: ((message: string) => void) | undefined,
): Promise<T> {
  const key = requireKey(auth);
  const refreshToken = await findOmnirushRefreshToken(key, auth);
  try {
    return await run(key);
  } catch (error) {
    if (!isOmnirushAuthFailure(error)) throw error;
    if (!refreshToken) throw error;
    onStatus?.("i Omnirush authentication rejected — refreshing token");
    const fresh = await refreshAndPersistOmnirushCredential(key, auth, refreshToken);
    onStatus?.("i Omnirush token refreshed — retrying request");
    return run(fresh.accessToken);
  }
}

function omnirushCacheKey(context: {
  model: string;
  messages: readonly CompletionRequest["messages"][number][];
  purpose: CompletionRequest["purpose"] | undefined;
}): string {
  const affinity = currentSessionAffinity();
  const key = affinity
    ? sessionCacheAffinityKey(affinity)
    : cacheAffinityKey("omnirush", context.model, context.messages);
  return `${context.purpose === "auxiliary" ? "aux-" : ""}${key}`;
}

function omnirushConfigFor(baseUrl: string): ResponsesDialectConfig {
  return {
    baseUrl,
    providerId: "omnirush",
    displayName: "Omnirush",
    artifactDialect: "openai-compatible",
    terminalPolicy: META_STREAM_TERMINAL,
    omitSampling: true,
    maxTokensField: "omit",
    omitParallelToolCalls: true,
    systemRole: "developer",
    buildHeaders(auth, accept) {
      return {
        "content-type": "application/json",
        accept,
        ...(auth.apiKey ? { authorization: `Bearer ${auth.apiKey}` } : {}),
        "user-agent": omnirushGatewayUserAgent(),
      };
    },
    reasoningPayload(reasoning) {
      if (!reasoning?.enabled) return undefined;
      return { effort: mapResponsesEffort(reasoning.effort), summary: "auto" };
    },
    bodyExtras(context) {
      return {
        store: false,
        prompt_cache_key: omnirushCacheKey(context),
      };
    },
  };
}

async function fetchOmnirushModels(apiKey: string, baseUrl: string): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: gatewayHeaders(apiKey, "application/json"),
  });
  if (!response.ok) {
    throw new ProviderError(
      `Omnirush model catalog request failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const payload = await readJson<unknown>(response);
  return ingestOpenAiModelCatalog("omnirush", payload);
}

export const omnirushProvider: LlmProvider = {
  id: "omnirush",
  displayName: "Omnirush",
  reasoningStyle: "openai",
  defaultModel: defaultModels.omnirush,
  envVar: "OMNIRUSH_API_KEY",
  validateKey: (key: string) => key.trim().length >= 16,
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const now = Date.now();
    if (cachedModels && now - lastFetchTime < CACHE_TTL_MS) return cachedModels;
    const baseUrl = gatewayBase(auth);
    let models: string[] = [];
    try {
      models = auth.apiKey
        ? await withOmnirushCredential(auth, (key) => fetchOmnirushModels(key, baseUrl))
        : [];
    } catch {
      models = [];
    }
    const result = models.length > 0 ? models : [...omnirushFallbackModels];
    if (result.length > 0) {
      cachedModels = result;
      lastFetchTime = now;
    }
    return result;
  },
  async ping(auth: ProviderAuth): Promise<void> {
    const baseUrl = gatewayBase(auth);
    await withOmnirushCredential(auth, async (key) => {
      const response = await fetch(`${baseUrl}/models`, {
        headers: gatewayHeaders(key, "application/json"),
      });
      if (!response.ok) {
        throw new ProviderError(
          `Omnirush authentication failed (HTTP ${response.status}). Run \`clai auth omnirush\` to sign in.`,
          response.status,
        );
      }
    });
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.omnirush;
    const config = omnirushConfigFor(gatewayBase(auth));
    return withOmnirushCredential(auth, (key) =>
      responsesStream(
        config,
        { ...request, provider: "omnirush", model },
        { apiKey: key },
        () => {},
        model,
      ),
    );
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
    onStatus?: ((message: string) => void) | undefined,
  ): Promise<CompletionResult> {
    const model = request.model ?? defaultModels.omnirush;
    const config = omnirushConfigFor(gatewayBase(auth));
    return withOmnirushCredential(
      auth,
      (key) =>
        responsesStream(
          config,
          { ...request, provider: "omnirush", model },
          { apiKey: key },
          onToken,
          model,
        ),
      onStatus,
    );
  },
};
