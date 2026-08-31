
import type { ProviderId } from "../types.js";
import type { ExaSearchType, SearchProviderId } from "../tools/web/types.js";
import { DEFAULT_EXA_SEARCH_TYPE } from "../tools/web/types.js";
import type { CustomProviderDef } from "../llm/custom-providers.js";

export type ProviderCategory = "local" | "free-cloud" | "paid-cloud";

export const endpointProviders: readonly ProviderId[] = [
  "modal",
  "lightning",
  "tokenrouter",
];

export function providerUsesEndpoints(provider: ProviderId): boolean {
  if (endpointProviders.includes(provider)) return true;
  return isCustomProviderIdSync(provider);
}

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
  modal: "paid-cloud",
  lightning: "paid-cloud",
  tokenrouter: "paid-cloud",
  meta: "paid-cloud",
  fireworks: "paid-cloud",
  hetzner: "free-cloud",
  orcarouter: "paid-cloud",
  "merge-gateway": "paid-cloud",
};

export function resolveProviderCategory(provider: ProviderId): ProviderCategory {
  return providerCategory[provider] ?? "paid-cloud";
}

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


export function getCustomProviders(): CustomProviderDef[] {
  const list = getConfig().customProviders ?? [];
  return list.map((d) => ({ ...d }));
}

export function isCustomProviderIdSync(id: string | ProviderId): boolean {
  const list = getConfig().customProviders ?? [];
  return list.some((d) => d.id === id);
}

export function addCustomProvider(def: CustomProviderDef): CustomProviderDef {
  const current = getConfig().customProviders ?? [];
  if (current.some((d) => d.id === def.id)) {
    throw new Error(`custom provider "${def.id}" already exists`);
  }
  updateConfig({ customProviders: [...current, def] });
  return def;
}

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

