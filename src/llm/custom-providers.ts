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

/** Persisted shape of one user-defined provider (JSON-serialisable). */
export interface CustomProviderDef {
  readonly id: string;
  readonly displayName: string;
  /** Normalised base URL ending in `/v1`. */
  readonly baseUrl: string;
  readonly envVar?: string | undefined;
  readonly defaultModel: string;
}

/** Build an OpenAI-compatible `LlmProvider` for a custom definition. */
export function buildCustomProvider(def: CustomProviderDef): LlmProvider {
  const providerId = def.id as ProviderId;
  const baseUrl = def.baseUrl;
  const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
  const CACHE_TTL_MS = 60 * 60 * 1000;
  let includeStreamUsage = true;

  return {
    id: providerId,
    displayName: def.displayName,
    defaultModel: def.defaultModel,
    ...(def.envVar ? { envVar: def.envVar } : {}),
    validateKey: (key: string) => key.trim().length >= 8,
    async listModels(auth: ProviderAuth): Promise<string[]> {
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
      if (!auth.apiKey) throw new Error(`${def.displayName} API key is required`);
      await openAiCompatiblePing(baseUrl, auth.apiKey);
    },
    async complete(request: CompletionRequest, auth: ProviderAuth): Promise<CompletionResult> {
      if (!auth.apiKey) throw new Error(`${def.displayName} API key is required`);
      const model = request.model ?? def.defaultModel;
      const payload = await openAiCompatibleComplete({
        provider: def.displayName, providerId, baseUrl, apiKey: auth.apiKey, model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal,
        reasoning: request.thinking, reasoningStyle: "openai",
        tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
      });
      return toCompletionResult(providerId, model, payload);
    },
    async stream(
      request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void,
    ): Promise<CompletionResult> {
      if (!auth.apiKey) throw new Error(`${def.displayName} API key is required`);
      const apiKey = auth.apiKey;
      const model = request.model ?? def.defaultModel;
      const stream = (withUsage: boolean) => openAiCompatibleStream({
        provider: def.displayName, providerId, baseUrl, apiKey, model,
        messages: request.messages, maxTokens: request.maxTokens,
        temperature: request.temperature, signal: request.signal, onToken,
        onToolCallDelta: request.onToolCallDelta, reasoning: request.thinking,
        reasoningStyle: "openai", tools: request.tools, toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        includeStreamUsage: withUsage,
      });
      let payload;
      try {
        payload = await stream(includeStreamUsage);
      } catch (error) {
        if (!includeStreamUsage || !isStreamOptionsUnsupportedError(error)) throw error;
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

/** Resolve the `LlmProvider` for a custom provider id. */
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
 * Sync variant: resolve the `LlmProvider` for a custom provider id by reading
 * the config directly. Used by the router's sync `getProvider` so the provider
 * map lookup works for custom ids without an `await`.
 *
 * The static import of `getCustomProviders` below does NOT create a runtime
 * cycle: `store/config.js` only imports the `CustomProviderDef` *type* from
 * this module (erased at compile time), so there is no runtime edge from
 * config → custom-providers to close the loop.
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

