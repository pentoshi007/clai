import { defaultModels, sanitizeProviderModel } from "../../llm/provider.js";
import type { ExaSearchType, SearchProviderId } from "../../tools/web/types.js";
import type { Mode, ProviderId, ReasoningPreference } from "../../types.js";
import { ClaiConfig, findCustomProviderDefSync, getConfig, store, updateConfig } from "./endpoints.js";
import { readFileSync } from "node:fs";

export function setDefaultProvider(provider: ProviderId): ClaiConfig {
  const model = getProviderModel(provider);
  return updateConfig({ defaultProvider: provider, defaultModel: model });
}

export function setDefaultMode(mode: Mode): ClaiConfig {
  return updateConfig({ defaultMode: mode });
}

export function setProviderModel(
  provider: ProviderId,
  model: string,
): ClaiConfig {
  const current = getConfig();
  const sanitized = sanitizeProviderModel(provider, model);
  const providerModels = { ...current.providerModels, [provider]: sanitized };
  return updateConfig({
    providerModels,
    ...(current.defaultProvider === provider ? { defaultModel: sanitized } : {}),
  });
}

export function getProviderModel(provider: ProviderId): string {
  const configured = getConfig().providerModels[provider];
  if (configured) return sanitizeProviderModel(provider, configured);
  const customDef = findCustomProviderDefSync(provider);
  if (customDef) return customDef.defaultModel;
  return defaultModels[provider];
}

export function hasExplicitConfigKey(key: keyof ClaiConfig): boolean {
  try {
    const raw = JSON.parse(readFileSync(store.path, "utf8")) as Record<
      string,
      unknown
    >;
    return Object.prototype.hasOwnProperty.call(raw, key);
  } catch {
    return false;
  }
}

export function setThinking(patch: Partial<ReasoningPreference>): ClaiConfig {
  const current = getConfig().thinking;
  const next: ReasoningPreference = {
    enabled: patch.enabled ?? current.enabled,
    effort: patch.effort ?? current.effort,
  };
  return updateConfig({ thinking: next });
}

export function setActiveSearchProvider(id: SearchProviderId): ClaiConfig {
  return updateConfig({ activeSearchProvider: id });
}

export function setExaSearchType(type: ExaSearchType): ClaiConfig {
  return updateConfig({ exaSearchType: type });
}
