import type {
  ProviderId,
  ReasoningEffort,
  ReasoningPreference,
} from "../types.js";
import type { ToolCallingMode } from "./tool-protocol.js";
import { EFFORT_SCALE } from "./reasoning-controls.js";
import { catalogEffortList, type CatalogFacts } from "./catalog-facts.js";
import { modelFamilyFor } from "./model-families.js";
import { GATEWAY_FAMILY_EXCLUDED_PROVIDERS } from "./provider-profile-layers.js";
import {
  endpointAcceptedEfforts,
  REASONING_PATTERNS,
} from "./reasoning-capability.js";
import {
  clampEffortToRoute,
  forgetNegativeControlDialect,
  negativeLearnedUnderAnotherDialect,
  routeControlDialect,
  setNegativeControlDialect,
  setRouteControlDialect,
} from "./route-dialect-registry.js";
import {
  clearPersistedLearnedRoutes,
  learnedRouteRejectedFields,
  clearPersistedLearnedRouteReasoning,
  learnSessionRejectedField,
  persistLearnedRoute,
  UNATTRIBUTED_CONTROL_DIALECT,
} from "./learned-capabilities.js";
import {
  capabilityKey,
  catalogFactsByRoute,
  catalogReasoningEfforts,
  catalogReasoningSupport,
  loadLearnedCapabilities,
  mandatoryReasoningRoutes,
  observedReasoningModels,
  providerModelCatalog,
  reasoningKey,
  reasoningUnsupportedModels,
  resetReasoningKnowledge as resetReasoningKnowledgeFromState,
  visionSubstitutions,
  wireRejectionEfforts,
} from "./capability/state.js";
import { registerModelVisionCapability } from "./capability/vision-registry.js";
import { resolveToolDialect } from "./capability/tool-dialect.js";
import { currentIsolatedSessionAffinity } from "./session-affinity.js";
export { resolveToolDialect };

export {
  clearLearnedVisionCapabilities,
  clearModelVisionCapabilities,
  learnModelVisionCapability,
  modelAcceptsImages,
  modelSupportsVision,
  modelVisionSupport,
  preferredVisionModel,
  visionCapabilitySource,
  visionEvidence,
  visionSubstitutionOrigin,
  warnOnUnknownProviderId,
} from "./capability/vision-registry.js";
export { isKnownPatternVisionModel } from "./capability/vision-patterns.js";
export { registerModelVisionCapability };
export {
  reloadLearnedCapabilities,
} from "./capability/state.js";

interface ScopedReasoningKnowledge {
  reasoningUnsupported?: true;
  reasoningMandatory?: true;
  reasoningObserved?: true;
  acceptedEfforts?: readonly string[];
  displayEfforts?: readonly string[] | undefined;
  declaredSupport?: boolean | undefined;
}

const scopedReasoningKnowledge = new Map<string, ScopedReasoningKnowledge>();
const MAX_SCOPED_REASONING_ROUTES = 512;

function scopedReasoningKey(provider: ProviderId, model: string): string | undefined {
  const scope = currentIsolatedSessionAffinity();
  return scope ? `${scope}\u0000${reasoningKey(provider, model)}` : undefined;
}

function scopedKnowledge(
  provider: ProviderId,
  model: string,
  create = true,
): ScopedReasoningKnowledge | undefined {
  const key = scopedReasoningKey(provider, model);
  if (!key) return undefined;
  let knowledge = scopedReasoningKnowledge.get(key);
  if (!knowledge && create) {
    loadLearnedCapabilities();
    const route = reasoningKey(provider, model);
    const efforts = wireRejectionEfforts.get(route);
    knowledge = {
      ...(reasoningUnsupportedModels.has(route) ? { reasoningUnsupported: true } : {}),
      ...(mandatoryReasoningRoutes.has(route) ? { reasoningMandatory: true } : {}),
      ...(observedReasoningModels.has(route) ? { reasoningObserved: true } : {}),
      ...(efforts?.length ? { acceptedEfforts: [...efforts] } : {}),
      displayEfforts: modelReasoningEfforts(provider, model) ?? endpointAcceptedEfforts(provider),
      declaredSupport: declaredThinkingSupport(provider, model),
    };
    scopedReasoningKnowledge.set(key, knowledge);
    while (scopedReasoningKnowledge.size > MAX_SCOPED_REASONING_ROUTES) {
      scopedReasoningKnowledge.delete(scopedReasoningKnowledge.keys().next().value!);
    }
  }
  if (knowledge) {
    scopedReasoningKnowledge.delete(key);
    scopedReasoningKnowledge.set(key, knowledge);
  }
  return knowledge;
}

export function resetReasoningKnowledge(): void {
  scopedReasoningKnowledge.clear();
  resetReasoningKnowledgeFromState();
}

export function markReasoningUnsupported(
  provider: ProviderId,
  model: string,
): void {
  const scoped = scopedKnowledge(provider, model, true);
  if (scoped) {
    scoped.reasoningUnsupported = true;
    return;
  }
  const key = reasoningKey(provider, model);
  reasoningUnsupportedModels.add(key);
  const dialect = routeControlDialect(key) ?? UNATTRIBUTED_CONTROL_DIALECT;
  setNegativeControlDialect(key, dialect);
  learnRouteReasoningSupport(provider, model, false);
}

export function registerRouteControlDialect(
  provider: ProviderId,
  model: string,
  dialect: string,
): void {
  if (!model.trim()) return;
  setRouteControlDialect(reasoningKey(provider, model), dialect);
}

export function isReasoningUnsupported(
  provider: ProviderId,
  model: string,
): boolean {
  loadLearnedCapabilities();
  const scoped = scopedKnowledge(provider, model);
  if (scoped) return scoped.reasoningUnsupported === true;
  const key = reasoningKey(provider, model);
  if (!reasoningUnsupportedModels.has(key)) return false;
  if (negativeLearnedUnderAnotherDialect(key)) {
    reasoningUnsupportedModels.delete(key);
    forgetNegativeControlDialect(key);
    clearPersistedLearnedRouteReasoning(key);
    return false;
  }
  return true;
}

export function clearReasoningUnsupported(): void {
  reasoningUnsupportedModels.clear();
}

export function effectiveThinkingEffort(
  provider: ProviderId,
  model: string,
  thinking: ReasoningPreference | undefined,
): ReasoningEffort | undefined {
  if (!thinking?.enabled) return undefined;
  if (isReasoningUnsupported(provider, model)) return undefined;
  if (!modelSupportsThinking(provider, model)) return undefined;
  return clampEffortToRoute(
    thinking.effort,
    displayReasoningEfforts(provider, model),
  );
}

export function registerRouteAcceptedEfforts(
  provider: ProviderId,
  model: string,
  efforts: readonly string[],
): void {
  if (!model.trim() || efforts.length === 0) return;
  catalogReasoningEfforts.set(reasoningKey(provider, model), [...efforts]);
}

export function registerWireRejectionEfforts(
  provider: ProviderId,
  model: string,
  efforts: readonly string[],
): void {
  if (!model.trim() || efforts.length === 0) return;
  const scoped = scopedKnowledge(provider, model, true);
  if (scoped) {
    scoped.acceptedEfforts = [...efforts];
    return;
  }
  wireRejectionEfforts.set(reasoningKey(provider, model), [...efforts]);
  registerRouteAcceptedEfforts(provider, model, efforts);
  persistLearnedRoute(reasoningKey(provider, model), {
    acceptedEfforts: [...efforts],
  });
}

export function learnRejectedEffort(
  provider: ProviderId,
  model: string,
  effort: ReasoningEffort,
): void {
  if (!model.trim()) return;
  const effective = displayReasoningEfforts(provider, model);
  if (!effective?.length) return;
  const reduced = effective.filter((value) => value !== effort);
  if (reduced.length === 0 || reduced.length === effective.length) return;
  registerWireRejectionEfforts(provider, model, reduced);
}

export function settleRouteEfforts(
  provider: ProviderId,
  model: string,
  requested: ReasoningEffort,
  succeeded: ReasoningEffort,
): void {
  if (!model.trim()) return;
  if (displayReasoningEfforts(provider, model) !== undefined) return;
  const rungIndex = EFFORT_SCALE.indexOf(succeeded);
  const requestedIndex = EFFORT_SCALE.indexOf(requested);
  if (rungIndex < 0 || requestedIndex < 0) return;
  const vocabulary =
    rungIndex < requestedIndex
      ? EFFORT_SCALE.slice(0, rungIndex + 1)
      : EFFORT_SCALE.slice(rungIndex);
  registerWireRejectionEfforts(provider, model, vocabulary);
}

export function markReasoningMandatory(
  provider: ProviderId,
  model: string,
): void {
  if (!model.trim()) return;
  const scoped = scopedKnowledge(provider, model, true);
  if (scoped) {
    scoped.reasoningMandatory = true;
    delete scoped.reasoningUnsupported;
    scoped.reasoningObserved = true;
    return;
  }
  const key = reasoningKey(provider, model);
  mandatoryReasoningRoutes.add(key);
  reasoningUnsupportedModels.delete(key);
  catalogReasoningSupport.set(key, true);
  observedReasoningModels.add(key);
  persistLearnedRoute(key, { reasoning: true, reasoningMandatory: true });
}

export function routeReasoningIsMandatory(
  provider: ProviderId,
  model: string,
): boolean {
  const scoped = scopedKnowledge(provider, model);
  if (scoped) return scoped.reasoningMandatory === true;
  return mandatoryReasoningRoutes.has(reasoningKey(provider, model));
}

export function learnedRouteEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  const scoped = scopedKnowledge(provider, model);
  if (scoped) return scoped.acceptedEfforts;
  const efforts = wireRejectionEfforts.get(reasoningKey(provider, model));
  return efforts?.length ? efforts : undefined;
}

export function scopedRuntimeReasoningEffortsKnown(
  provider: ProviderId,
  model: string,
): boolean | undefined {
  const key = scopedReasoningKey(provider, model);
  if (!key) return undefined;
  return Boolean(scopedReasoningKnowledge.get(key)?.acceptedEfforts?.length);
}

export function learnModelReasoningSupport(
  provider: ProviderId,
  model: string,
): void {
  if (!model.trim()) return;
  const scoped = scopedKnowledge(provider, model, true);
  if (scoped) {
    scoped.reasoningObserved = true;
    return;
  }
  registerModelReasoningSupport(provider, model, true);
}

export function clearReasoningRejection(
  provider: ProviderId,
  model: string,
): void {
  const scoped = scopedKnowledge(provider, model);
  if (scoped) {
    delete scoped.reasoningUnsupported;
    return;
  }
  const key = reasoningKey(provider, model);
  reasoningUnsupportedModels.delete(key);
  clearPersistedLearnedRouteReasoning(key);
}

export function registerModelReasoningSupport(
  provider: ProviderId,
  model: string,
  supported: boolean,
): void {
  if (!model.trim()) return;
  catalogReasoningSupport.set(reasoningKey(provider, model), supported);
}

export function learnModelEmitsReasoning(
  provider: ProviderId,
  model: string,
): void {
  if (!model.trim()) return;
  const scoped = scopedKnowledge(provider, model, true);
  if (scoped) {
    scoped.reasoningObserved = true;
    return;
  }
  observedReasoningModels.add(reasoningKey(provider, model));
}

export type ReasoningEvidence =
  "rejected" | "observed" | "catalog" | "pattern" | "family" | "endpoint" | "unknown";

function familyForProvider(provider: ProviderId, model: string) {
  const family = modelFamilyFor(model);
  const providerExcluded =
    family?.id === "mimo-v2" && provider !== "mimo";
  const gatewayExcluded = GATEWAY_FAMILY_EXCLUDED_PROVIDERS[
    family?.id ?? ""
  ]?.includes(provider);
  return providerExcluded || gatewayExcluded ? undefined : family;
}

export function modelReasoningEvidence(
  provider: ProviderId,
  model: string,
): ReasoningEvidence {
  const scoped = scopedKnowledge(provider, model);
  if (scoped?.reasoningUnsupported) return "rejected";
  if (scoped?.reasoningObserved) return "observed";
  const key = reasoningKey(provider, model);
  if (!scoped && reasoningUnsupportedModels.has(key)) return "rejected";
  if (!scoped && observedReasoningModels.has(key)) return "observed";
  if (catalogReasoningSupport.has(key)) return "catalog";
  const facts = catalogFactsByRoute.get(key);
  if (facts?.reasoning?.supported !== undefined) return "catalog";
  if (catalogAdvertisedEfforts(provider, model) !== undefined) return "catalog";
  const patterns = REASONING_PATTERNS[provider] ?? [];
  if (patterns.some((pattern) => pattern.test(model))) return "pattern";
  if (familyForProvider(provider, model)) return "family";
  return endpointAcceptedEfforts(provider) ? "endpoint" : "unknown";
}

export function modelSupportsThinking(
  provider: ProviderId,
  model: string,
): boolean {
  loadLearnedCapabilities();
  const scoped = scopedKnowledge(provider, model);
  if (scoped?.reasoningUnsupported) return false;
  if (scoped?.reasoningObserved) return true;
  const key = reasoningKey(provider, model);
  if (!scoped && reasoningUnsupportedModels.has(key)) return false;
  if (!scoped && observedReasoningModels.has(key)) return true;
  return scoped ? scoped.declaredSupport === true : declaredThinkingSupport(provider, model);
}

function declaredThinkingSupport(provider: ProviderId, model: string): boolean {
  const key = reasoningKey(provider, model);
  const declared = catalogReasoningSupport.get(key);
  if (declared !== undefined) return declared;
  const facts = catalogFactsByRoute.get(key);
  if (facts?.reasoning?.supported !== undefined) return facts.reasoning.supported;
  if (catalogAdvertisedEfforts(provider, model) !== undefined) return true;
  if (familyForProvider(provider, model)) return true;
  const patterns = REASONING_PATTERNS[provider];
  if (patterns === undefined) return true;
  if (patterns.some((pattern) => pattern.test(model))) return true;
  return endpointAcceptedEfforts(provider) !== undefined;
}

export function displayReasoningEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  const scoped = scopedKnowledge(provider, model);
  if (scoped) return scoped.acceptedEfforts ?? scoped.displayEfforts;
  return (
    modelReasoningEfforts(provider, model) ?? endpointAcceptedEfforts(provider)
  );
}

const unavailableModels = new Set<string>();

export function registerProviderModels(
  provider: ProviderId,
  models: readonly string[],
): void {
  if (models.length === 0) return;
  providerModelCatalog.set(
    provider,
    new Set(models.map((model) => model.trim().toLowerCase())),
  );
}

export interface CatalogModel {
  readonly id: string;
  readonly vision?: boolean | undefined;
  readonly reasoning?: boolean | undefined;
  readonly reasoningEfforts?: readonly string[] | undefined;
  readonly facts?: CatalogFacts | undefined;
}

export function registerModelCatalogFacts(
  provider: ProviderId,
  facts: CatalogFacts,
): void {
  if (!facts.id.trim()) return;
  catalogFactsByRoute.set(reasoningKey(provider, facts.id), facts);
}

export function modelCatalogFacts(
  provider: ProviderId | string,
  model: string,
): CatalogFacts | undefined {
  return catalogFactsByRoute.get(`${provider}:${model.trim().toLowerCase()}`);
}

export function clearModelCatalogFacts(): void {
  catalogFactsByRoute.clear();
}

export function registerModelReasoningEfforts(
  provider: ProviderId,
  model: string,
  efforts: readonly string[],
): void {
  const normalized = efforts
    .map((effort) => effort.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return;
  catalogReasoningEfforts.set(reasoningKey(provider, model), normalized);
}

export function catalogAdvertisedEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  const key = reasoningKey(provider, model);
  const registered = catalogReasoningEfforts.get(key);
  if (registered?.length) return registered;
  const facts = catalogFactsByRoute.get(key);
  const efforts = catalogEffortList(facts?.reasoning?.supportedEfforts);
  return efforts?.length ? efforts : undefined;
}

export function modelReasoningEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  loadLearnedCapabilities();
  const advertised = catalogAdvertisedEfforts(provider, model);
  if (advertised !== undefined) return advertised;
  const family = familyForProvider(provider, model);
  return family && family.acceptedEfforts.length > 0
    ? family.acceptedEfforts
    : undefined;
}

export function modelReasoningIsMandatory(model: string): boolean {
  return modelFamilyFor(model)?.generation === "mandatory";
}

export function clearModelReasoningEfforts(): void {
  catalogReasoningEfforts.clear();
}

export function registerModelCatalog(
  provider: ProviderId,
  models: readonly CatalogModel[],
): void {
  registerProviderModels(
    provider,
    models.map((model) => model.id).filter((id) => id.length > 0),
  );
  for (const model of models) {
    if (!model.id) continue;
    if (model.facts) registerModelCatalogFacts(provider, model.facts);
    if (model.reasoningEfforts?.length) {
      registerModelReasoningEfforts(provider, model.id, model.reasoningEfforts);
    }
    if (model.reasoning !== undefined) {
      registerModelReasoningSupport(provider, model.id, model.reasoning);
    }
    if (model.vision === undefined) continue;
    registerModelVisionCapability({
      provider,
      model: model.id,
      vision: model.vision,
      source: "provider",
    });
  }
}

export function providerModelIsKnown(
  provider: ProviderId,
  model: string,
): boolean | undefined {
  const catalog = providerModelCatalog.get(provider);
  if (!catalog) return undefined;
  return catalog.has(model.trim().toLowerCase());
}

export function markModelUnavailable(
  provider: ProviderId,
  model: string,
): void {
  unavailableModels.add(capabilityKey(provider, model));
}

export function isModelUnavailable(
  provider: ProviderId,
  model: string,
): boolean {
  return unavailableModels.has(capabilityKey(provider, model));
}

export function recordVisionSubstitution(
  provider: ProviderId,
  substitute: string,
  original: string,
): void {
  visionSubstitutions.set(capabilityKey(provider, substitute), original);
}

export function clearProviderModelKnowledge(): void {
  providerModelCatalog.clear();
  unavailableModels.clear();
  visionSubstitutions.clear();
}

export function learnRouteReasoningSupport(
  provider: ProviderId,
  model: string,
  reasoning: boolean,
): void {
  if (!model.trim()) return;
  const key = reasoningKey(provider, model);
  if (!reasoning) {
    clearPersistedLearnedRouteReasoning(key);
    return;
  }
  persistLearnedRoute(key, { reasoning });
}

export function learnRouteAcceptedEfforts(
  provider: ProviderId,
  model: string,
  acceptedEfforts: readonly string[],
): void {
  const normalized = acceptedEfforts
    .map((effort) => effort.trim().toLowerCase())
    .filter(Boolean);
  if (normalized.length === 0) return;
  persistLearnedRoute(reasoningKey(provider, model), {
    acceptedEfforts: normalized,
  });
}

export function learnRouteLimits(
  provider: ProviderId,
  model: string,
  limits: {
    contextTokens?: number | undefined;
    maxOutputTokens?: number | undefined;
  },
): void {
  if (
    limits.contextTokens === undefined &&
    limits.maxOutputTokens === undefined
  ) {
    return;
  }
  persistLearnedRoute(reasoningKey(provider, model), {
    ...(limits.contextTokens !== undefined
      ? { contextTokens: limits.contextTokens }
      : {}),
    ...(limits.maxOutputTokens !== undefined
      ? { maxOutputTokens: limits.maxOutputTokens }
      : {}),
  });
}

export function learnRouteRejectedField(
  provider: ProviderId,
  model: string,
  field: string,
): void {
  if (!model.trim()) return;
  learnSessionRejectedField(reasoningKey(provider, model), field);
}

export function clearLearnedRouteCapabilities(): void {
  clearPersistedLearnedRoutes();
}

export { learnedRouteRejectedFields };

export type VisionSupport = "yes" | "no" | "unknown";

export type VisionEvidence = "observed" | "pattern" | "none";

export function modelSupportsNativeTools(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): boolean {
  return resolveToolDialect(provider, model, toolCalling) !== "none";
}
