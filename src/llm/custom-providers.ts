/**
 * Runtime registry for user-defined ("custom") LLM providers.
 *
 * Built-in providers live in the compile-time `providerIds` tuple, so their
 * `ProviderId` values are part of the type system. Custom providers are added
 * at runtime by the user (via the `/provider` "Add custom provider" flow) and
 * are plain strings. This module is the single source of truth for those.
 */

import type { CompletionRequest, CompletionResult, ProviderId } from "../types.js";
import { normalizeEndpointUrl, type LlmProvider, type ProviderAuth } from "./provider.js";
import {
  openAiCompatibleComplete,
  openAiCompatiblePing,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  ingestOpenAiModelCatalog,
  isStreamOptionsUnsupportedError,
} from "./http.js";
import type { CompatibleUsageAliases } from "./token-usage.js";
import {
  customReasoningStyle,
  endpointPrivacyHash,
  resolveCustomHeaders,
  validateCustomProviderProfile,
  type CustomProviderProfileSpec,
} from "./custom-provider-profile.js";
import { recordControlRejection } from "./provider-profile.js";
import { CHAT_COMPLETIONS_STREAM_TERMINAL } from "./stream-terminal.js";

/** Persisted shape of one user-defined provider (JSON-serialisable). */
export interface CustomProviderDef {
  readonly id: string;
  readonly displayName: string;
  /** Normalised base URL ending in `/v1`. */
  readonly baseUrl: string;
  readonly envVar?: string | undefined;
  /** Separate API-key environment; takes precedence over `envVar`. */
  readonly keyEnv?: string | undefined;
  /** Separate endpoint environment; `envVar` never doubles as one. */
  readonly baseUrlEnv?: string | undefined;
  readonly defaultModel: string;
  /** Optional telemetry-only aliases relative to a compatible `usage` object. */
  readonly usageAliases?: CompatibleUsageAliases | undefined;
  /** Optional validated wire-profile declaration. */
  readonly profile?: CustomProviderProfileSpec | undefined;
}

/** Validation errors for a definition's declared profile, if any. */
export function customProviderProfileErrors(
  def: CustomProviderDef,
): string[] {
  if (!def.profile) return [];
  return validateCustomProviderProfile(def.profile).errors;
}

function resolveBaseUrl(def: CustomProviderDef, auth: ProviderAuth): string {
  const override = normalizeEndpointUrl(auth.baseUrl ?? "");
  return override || def.baseUrl;
}

function authHeaders(
  def: CustomProviderDef,
  apiKey: string | undefined,
): Record<string, string> | undefined {
  const declared = resolveCustomHeaders(def.profile?.headers);
  if (def.profile?.authType === "none-keyless") return declared;
  if (def.profile?.authType === "custom-headers") return declared;
  if (declared && apiKey) {
    return { authorization: `Bearer ${apiKey}`, ...declared };
  }
  return undefined;
}

/** Build an OpenAI-compatible `LlmProvider` for a custom definition. */
export function buildCustomProvider(def: CustomProviderDef): LlmProvider {
  const providerId = def.id as ProviderId;
  const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
  const CACHE_TTL_MS = 60 * 60 * 1000;
  const keyless =
    def.profile?.authType === "none-keyless" ||
    def.profile?.authType === "custom-headers";
  // Declared stream-option capability: "supported" suppresses the adaptive
  // retry (a rejection becomes route evidence, not a second request);
  // "unsupported" omits the field from the first request onward.
  const declaredStreamOptions = def.profile?.streamOptions;
  let includeStreamUsage = declaredStreamOptions !== "unsupported";
  const reasoningStyle = customReasoningStyle(def.profile);

  const requireKey = (auth: ProviderAuth): string | undefined => {
    if (keyless) return undefined;
    if (!auth.apiKey) throw new Error(`${def.displayName} API key is required`);
    return auth.apiKey;
  };

  return {
    id: providerId,
    displayName: def.displayName,
    defaultModel: def.defaultModel,
    reasoningStyle,
    ...(def.keyEnv ?? def.envVar
      ? { envVar: def.keyEnv ?? def.envVar }
      : {}),
    validateKey: (key: string) => key.trim().length >= 8,
    async listModels(auth: ProviderAuth): Promise<string[]> {
      const baseUrl = resolveBaseUrl(def, auth);
      const cacheKey = `${baseUrl}|${auth.apiKey ?? ""}`;
      const now = Date.now();
      const cached = modelCache.get(cacheKey);
      if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.models;
      try {
        const headers: Record<string, string> = {};
        if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
        const response = await fetch(`${baseUrl}/models`, { headers });
        const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
        const models = ingestOpenAiModelCatalog(providerId, data);
        if (models.length > 0) modelCache.set(cacheKey, { models, fetchedAt: now });
        return models;
      } catch {
        return [];
      }
    },
    async ping(auth: ProviderAuth): Promise<void> {
      const apiKey = requireKey(auth);
      await openAiCompatiblePing(
        resolveBaseUrl(def, auth),
        apiKey ?? "",
        authHeaders(def, apiKey),
      );
    },
    async complete(request: CompletionRequest, auth: ProviderAuth): Promise<CompletionResult> {
      const apiKey = requireKey(auth);
      const model = request.model ?? def.defaultModel;
      const payload = await openAiCompatibleComplete({
        provider: def.displayName, providerId,
        baseUrl: resolveBaseUrl(def, auth), apiKey: apiKey ?? "",
        headers: authHeaders(def, apiKey), model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal,
        reasoning: request.thinking, reasoningStyle,
        tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        usageAliases: def.usageAliases,
      });
      return toCompletionResult(providerId, model, payload);
    },
    async stream(
      request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void,
    ): Promise<CompletionResult> {
      const apiKey = requireKey(auth);
      const model = request.model ?? def.defaultModel;
      const baseUrl = resolveBaseUrl(def, auth);
      const headers = authHeaders(def, apiKey);
      const stream = (withUsage: boolean) => openAiCompatibleStream({
        provider: def.displayName, providerId, baseUrl,
        apiKey: apiKey ?? "", headers, model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal, onToken,
        onToolCallDelta: request.onToolCallDelta, onStreamEvent: request.onStreamEvent, reasoning: request.thinking,
        reasoningStyle, tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
        includeStreamUsage: withUsage,
        usageAliases: def.usageAliases,
        streamTerminal:
          def.profile?.terminal?.naturalEofAccepted === true
            ? { ...CHAT_COMPLETIONS_STREAM_TERMINAL, naturalEofAccepted: true }
            : undefined,
      });
      let payload;
      try {
        payload = await stream(includeStreamUsage);
      } catch (error) {
        if (!includeStreamUsage || !isStreamOptionsUnsupportedError(error)) throw error;
        if (declaredStreamOptions === "supported") {
          recordControlRejection({
            provider: def.id,
            model,
            endpointHash: endpointPrivacyHash(baseUrl),
            field: "stream_options",
          });
          throw error;
        }
        includeStreamUsage = false;
        payload = await stream(false);
      }
      return toCompletionResult(providerId, model, payload);
    },
  };
}

// --- Registry (reads ClaiConfig.customProviders via lazy import) ----------------

/** Lazily-imported config reader to avoid a circular dep on store/config.js. */
async function readCustomDefs(): Promise<CustomProviderDef[]> {
  const { getCustomProviders } = await import("../store/config.js");
  return getCustomProviders();
}

/** All custom provider ids currently registered in config. */
export async function getCustomProviderIds(): Promise<string[]> {
  const defs = await readCustomDefs();
  return defs.map((d) => d.id);
}

/** Resolve a custom definition by id (sync, against a provided defs list). */
export function findCustomProviderDef(
  id: string,
  defs: readonly CustomProviderDef[],
): CustomProviderDef | undefined {
  return defs.find((d) => d.id === id);
}

/** In-memory cache of materialised `LlmProvider` instances keyed by id. */
const providerCache = new Map<string, LlmProvider>();

/** Resolve a custom definition by id. */
export async function getCustomProvider(id: string): Promise<LlmProvider | undefined> {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const defs = await readCustomDefs();
  const def = findCustomProviderDef(id, defs);
  if (!def) return undefined;
  const built = buildCustomProvider(def);
  providerCache.set(id, built);
  return built;
}

/**
 * Sync variant: resolve a custom definition by reading the config directly.
 * This remains safe because config imports this module's type only.
 */
import { getCustomProviders } from "../store/config.js";

export function getCustomProviderSync(id: string): LlmProvider | undefined {
  const cached = providerCache.get(id);
  if (cached) return cached;
  const def = findCustomProviderDef(id, getCustomProviders());
  if (!def) return undefined;
  const built = buildCustomProvider(def);
  providerCache.set(id, built);
  return built;
}

/** Invalidate the in-memory provider cache for one id (or all when omitted). */
export function invalidateCustomProviderCache(id?: string): void {
  if (id) providerCache.delete(id);
  else providerCache.clear();
}

/** Build an `LlmProvider` from a definition without config (for the add flow). */
export function materializeCustomProvider(def: CustomProviderDef): LlmProvider {
  return buildCustomProvider(def);
}

/** Validate + normalise a candidate custom provider id. Returns `""` on invalid. */
export function normalizeCustomProviderId(raw: string, existing: readonly string[]): string {
  const id = raw.trim().toLowerCase();
  if (!id) return "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return "";
  if (existing.includes(id)) return "";
  return id;
}

/** Normalise a base URL the way the OpenAI helpers expect (`/v1` suffix). */
export function normalizeCustomBaseUrl(raw: string): string {
  return normalizeEndpointUrl(raw);
}
