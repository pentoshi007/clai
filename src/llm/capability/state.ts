import type { LearnedRouteEntry } from "../../store/config.js";
import type { ProviderId } from "../../types.js";
import { isModelUnavailable, providerModelIsKnown } from "../capabilities.js";
import type { CatalogFacts } from "../catalog-facts.js";
import {
  clearPersistedLearnedRouteReasoning,
  clearSessionRejectedFields,
  learnedRouteAt,
  learnedRouteCapabilities,
  learnedVisionCapabilities,
  negativeIsStale,
  readLearnedVisionEntry,
} from "../learned-capabilities.js";
import { clearRouteDialectRegistry } from "../route-dialect-registry.js";

export const reasoningUnsupportedModels = new Set<string>();

export const reasoningKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model
    .trim()
    .toLowerCase()
    .replace(/^free-\d+\//, "")}`;

export const mandatoryReasoningRoutes = new Set<string>();

export const wireRejectionEfforts = new Map<string, readonly string[]>();

export const catalogReasoningSupport = new Map<string, boolean>();

export const observedReasoningModels = new Set<string>();

export function resetReasoningKnowledge(): void {
  reasoningUnsupportedModels.clear();
  mandatoryReasoningRoutes.clear();
  wireRejectionEfforts.clear();
  catalogReasoningSupport.clear();
  observedReasoningModels.clear();
  catalogReasoningEfforts.clear();
  catalogFactsByRoute.clear();
  clearRouteDialectRegistry();
  clearSessionRejectedFields();
  learnedLoaded = true;
}

export const visionCapabilityCache = new Map<
  string,
  { vision: boolean; source: "provider" | "user"; observedAt: string }
>();

export const capabilityKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model.trim().toLowerCase()}`;

export const providerModelCatalog = new Map<ProviderId, Set<string>>();

export const visionSubstitutions = new Map<string, string>();

export const catalogReasoningEfforts = new Map<string, readonly string[]>();

export const catalogFactsByRoute = new Map<string, CatalogFacts>();

export function configuredVisionModel(
  provider: ProviderId,
): string | undefined {
  const envKey = `CLAI_VISION_MODEL_${provider.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() || undefined;
}

export let learnedLoaded = false;

export function setLearnedLoaded(value: boolean): void {
  learnedLoaded = value;
}

export function loadLearnedCapabilities(): void {
  if (learnedLoaded) return;
  learnedLoaded = true;
  for (const [key, raw] of Object.entries(learnedVisionCapabilities())) {
    if (visionCapabilityCache.has(key)) continue;
    const entry = readLearnedVisionEntry(raw);
    if (!entry) continue;
    if (!entry.vision && negativeIsStale(entry.at)) continue;
    visionCapabilityCache.set(key, {
      vision: entry.vision,
      source: "provider",
      observedAt: new Date(entry.at).toISOString(),
    });
  }
  for (const [key, entry] of Object.entries(learnedRouteCapabilities())) {
    applyLearnedRouteEntry(key, entry);
  }
}

function applyLearnedRouteEntry(key: string, entry: LearnedRouteEntry): void {
  const at = learnedRouteAt(entry);
  const stale = negativeIsStale(at);
  if (
    entry.vision !== undefined &&
    !visionCapabilityCache.has(key) &&
    (entry.vision || !stale)
  ) {
    visionCapabilityCache.set(key, {
      vision: entry.vision,
      source: "provider",
      observedAt: new Date(at).toISOString(),
    });
  }
  if (entry.reasoning === true) observedReasoningModels.add(key);
  else if (entry.reasoning === false) {
    clearPersistedLearnedRouteReasoning(key);
  }
  if (entry.reasoningMandatory === true) {
    mandatoryReasoningRoutes.add(key);
    reasoningUnsupportedModels.delete(key);
    catalogReasoningSupport.set(key, true);
    if (entry.acceptedEfforts?.length) {
      wireRejectionEfforts.set(
        key,
        entry.acceptedEfforts
          .map((effort: string) => effort.trim().toLowerCase())
          .filter(Boolean),
      );
    }
  }
  if (entry.acceptedEfforts?.length) {
    catalogReasoningEfforts.set(
      key,
      entry.acceptedEfforts
        .map((effort: string) => effort.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  if (
    entry.contextTokens === undefined &&
    entry.maxOutputTokens === undefined
  ) {
    return;
  }
  const model = key.slice(key.indexOf(":") + 1);
  if (!model) return;
  const existing = catalogFactsByRoute.get(key);
  catalogFactsByRoute.set(key, {
    ...existing,
    id: existing?.id ?? model,
    ...(entry.contextTokens !== undefined
      ? { contextTokens: entry.contextTokens }
      : {}),
    ...(entry.maxOutputTokens !== undefined
      ? { maxOutputTokens: entry.maxOutputTokens }
      : {}),
  });
}

export function reloadLearnedCapabilities(): void {
  learnedLoaded = false;
  loadLearnedCapabilities();
}

export function isSelectableModel(
  provider: ProviderId,
  model: string,
): boolean {
  if (isModelUnavailable(provider, model)) return false;
  return providerModelIsKnown(provider, model) !== false;
}
