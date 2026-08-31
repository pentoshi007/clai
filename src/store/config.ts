
import type { ProviderId } from "../types.js";
import type { ExaSearchType, SearchProviderId } from "../tools/web/types.js";
import { DEFAULT_EXA_SEARCH_TYPE } from "../tools/web/types.js";
import type { CustomProviderDef } from "../llm/custom-providers.js";

export type ProviderCategory = "local" | "free-cloud" | "paid-cloud";

/**
 * Providers whose base URL is user-supplied. `modal` requires one (endpoints
 * are per-workspace); `lightning` treats it as an override of the shared
 * gateway, e.g. to point at a private Lightning Inference deployment.
 */
export const endpointProviders: readonly ProviderId[] = [
  "modal",
  "lightning",
  "tokenrouter",
];

export function providerUsesEndpoints(provider: ProviderId): boolean {
  if (endpointProviders.includes(provider)) return true;
  // Custom providers always carry a user-supplied base URL.
  return isCustomProviderIdSync(provider);
}

/**
 * Best-effort classification for the built-in providers. Some "free-cloud"
 * providers have paid tiers too — the label reflects what the default keys
 * usually buy you. Users who set up paid OpenAI/Anthropic keys can flip
 * freeOnly off to opt back into them.
 */
export const providerCategory: Record<ProviderId, ProviderCategory> = {
  free: "free-cloud",
  gemini: "free-cloud",
  openrouter: "free-cloud",
  nvidia: "free-cloud",
  ollama: "local",
  openai: "paid-cloud",
  anthropic: "paid-cloud",
  agentrouter: "paid-cloud",
  "aws-mantle": "paid-cloud",
  bynara: "free-cloud",
  "qwen-cloud": "paid-cloud",
  // Usage-based compute billing. The Starter plan's $30/month credit makes it
  // free in practice for light use, but it still spends real money, so
  // `freeOnly` must keep it out of the fallback chain.
  modal: "paid-cloud",
  // Per-token billing after the introductory free-token grant, so keep it out
  // of `freeOnly` runs.
  lightning: "paid-cloud",
  // Prepaid balance, billed per token.
  tokenrouter: "paid-cloud",
  meta: "paid-cloud",
  fireworks: "paid-cloud",
  hetzner: "free-cloud",
  // Zero token markup, but billing is per token at provider list price.
  orcarouter: "paid-cloud",
  "merge-gateway": "paid-cloud",
};

/**
 * Resolve the category for any provider id (built-in or custom). Custom
 * providers default to "paid-cloud" so `/freeonly` keeps them out of the
 * fallback chain unless the user explicitly switched to one.
 */
export function resolveProviderCategory(provider: ProviderId): ProviderCategory {
  return providerCategory[provider] ?? "paid-cloud";
}

// Inject the custom-provider id resolver so `normalizeProvider`/`assertProvider`
// recognise user-defined provider ids. Done once, after the store is live.
import { setCustomDefaultModelResolver, setCustomProviderInfoResolver, setCustomProviderResolver, setEnvVarResolver } from "../llm/provider.js";
import { setCustomProfileSpecResolver } from "../llm/custom-profile-resolver.js";
import { ClaiConfig, findCustomProviderDefSync, getConfig, store, updateConfig } from "./config/endpoints.js";
export { getProviderModel, hasExplicitConfigKey, setActiveSearchProvider, setDefaultMode, setDefaultProvider, setExaSearchType, setProviderModel, setThinking } from "./config/settings.js";
export { MAX_PROVIDER_ENDPOINTS, appendProviderEndpoint, getActiveProviderEndpoint, getProviderEndpoints, setActiveProviderEndpoint, setProviderEndpointDisabled, setProviderEndpoints } from "./config/endpoints.js";
export { findCustomProviderDefSync, getConfig, updateConfig };
export type { ClaiConfig, LearnedRouteEntry, LearnedVisionEntry, ProviderEndpoints } from "./config/endpoints.js";
setCustomProviderResolver((id: string): boolean => {
  const list = getConfig().customProviders ?? [];
  return list.some((d) => d.id === id);
});
setEnvVarResolver((provider) => findCustomProviderDefSync(provider)?.envVar);
setCustomDefaultModelResolver((provider) => findCustomProviderDefSync(provider)?.defaultModel);
setCustomProfileSpecResolver((provider) => findCustomProviderDefSync(provider)?.profile);
setCustomProviderInfoResolver((provider) => {
  const def = findCustomProviderDefSync(provider);
  if (!def) return undefined;
  const env = def.envVar ? `\nENVIRONMENT VARIABLE\n  ${def.envVar}  API key (used when nothing is stored)\n` : "";
  return `${def.displayName} — custom OpenAI-compatible provider

CONFIGURATION
  id:            ${def.id}
  base URL:      ${def.baseUrl}
  default model: ${def.defaultModel}${env}

MANAGING KEYS
  clai set ${def.id} <key>       add an API key (up to 10, rotated on failure)
  clai set ${def.id} <key2>      add another; the last that worked is sticky
  /set ${def.id}                 multi-key editor
  clai unset ${def.id}           remove every stored key

This provider was added manually via the /provider picker. It speaks the
standard OpenAI Chat Completions API (/chat/completions, /models, SSE
streaming, native tool calling, reasoning_effort). Use /model to pick from
the live catalogue fetched from ${def.baseUrl}/models.`;
});

// --- Custom provider definitions (user-defined, runtime registry) --------------

/** All custom provider defs stored in config. */
export function getCustomProviders(): CustomProviderDef[] {
  const list = getConfig().customProviders ?? [];
  return list.map((d) => ({ ...d }));
}

/** True when `id` matches a user-defined custom provider (sync, reads config). */
export function isCustomProviderIdSync(id: string | ProviderId): boolean {
  const list = getConfig().customProviders ?? [];
  return list.some((d) => d.id === id);
}

/** Persist a new custom provider definition. Throws on duplicate id. */
export function addCustomProvider(def: CustomProviderDef): CustomProviderDef {
  const current = getConfig().customProviders ?? [];
  if (current.some((d) => d.id === def.id)) {
    throw new Error(`custom provider "${def.id}" already exists`);
  }
  updateConfig({ customProviders: [...current, def] });
  return def;
}

/** Remove a custom provider definition (does not touch its stored keys). */
export function removeCustomProvider(id: string): boolean {
  const current = getConfig().customProviders ?? [];
  const next = current.filter((d) => d.id !== id);
  if (next.length === current.length) return false;
  updateConfig({ customProviders: next });
  return true;
}

export function getConfigPath(): string {
  return store.path;
}

export function getActiveSearchProvider(): SearchProviderId {
  return getConfig().activeSearchProvider;
}

export function getExaSearchType(): ExaSearchType {
  return getConfig().exaSearchType ?? DEFAULT_EXA_SEARCH_TYPE;
}

