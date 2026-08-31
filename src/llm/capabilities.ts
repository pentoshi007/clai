import type {
  ProviderId,
  ReasoningEffort,
  ReasoningPreference,
} from "../types.js";
import type { ToolCallingMode } from "./tool-protocol.js";
import type { CatalogFacts } from "./catalog-facts.js";
import { modelFamilyFor } from "./model-families.js";
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
  persistLearnedRoute,
  readLearnedRoute,
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
  visionSubstitutions,
  wireRejectionEfforts,
} from "./capability/state.js";
import { registerModelVisionCapability } from "./capability/vision-registry.js";
import { resolveToolDialect } from "./capability/tool-dialect.js";
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
export { registerModelVisionCapability };
export {
  reloadLearnedCapabilities,
  resetReasoningKnowledge,
} from "./capability/state.js";

/** Mark a model as having rejected reasoning options so we stop sending them. */
export function markReasoningUnsupported(
  provider: ProviderId,
  model: string,
): void {
  const key = reasoningKey(provider, model);
  reasoningUnsupportedModels.add(key);
  const dialect = routeControlDialect(key) ?? UNATTRIBUTED_CONTROL_DIALECT;
  setNegativeControlDialect(key, dialect);
  learnRouteReasoningSupport(provider, model, false, dialect);
}

export function registerRouteControlDialect(
  provider: ProviderId,
  model: string,
  dialect: string,
): void {
  if (!model.trim()) return;
  setRouteControlDialect(reasoningKey(provider, model), dialect);
}

/** Whether a model was observed to reject reasoning options this session. */
export function isReasoningUnsupported(
  provider: ProviderId,
  model: string,
): boolean {
  loadLearnedCapabilities();
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
  wireRejectionEfforts.set(reasoningKey(provider, model), [...efforts]);
  registerRouteAcceptedEfforts(provider, model, efforts);
  persistLearnedRoute(reasoningKey(provider, model), {
    acceptedEfforts: [...efforts],
  });
}

export function markReasoningMandatory(
  provider: ProviderId,
  model: string,
): void {
  if (!model.trim()) return;
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
  return mandatoryReasoningRoutes.has(reasoningKey(provider, model));
}

export function learnedRouteEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  const efforts = wireRejectionEfforts.get(reasoningKey(provider, model));
  return efforts?.length ? efforts : undefined;
}

export function clearReasoningRejection(
  provider: ProviderId,
  model: string,
): void {
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
  observedReasoningModels.add(reasoningKey(provider, model));
}

export type ReasoningEvidence =
  "rejected" | "observed" | "catalog" | "pattern" | "endpoint" | "unknown";

export function modelReasoningEvidence(
  provider: ProviderId,
  model: string,
): ReasoningEvidence {
  const key = reasoningKey(provider, model);
  if (reasoningUnsupportedModels.has(key)) return "rejected";
  if (observedReasoningModels.has(key)) return "observed";
  if (catalogReasoningSupport.has(key)) return "catalog";
  const patterns = REASONING_PATTERNS[provider] ?? [];
  if (patterns.some((pattern) => pattern.test(model))) return "pattern";
  return endpointAcceptedEfforts(provider) ? "endpoint" : "unknown";
}

export function modelSupportsThinking(
  provider: ProviderId,
  model: string,
): boolean {
  loadLearnedCapabilities();
  const key = reasoningKey(provider, model);
  if (reasoningUnsupportedModels.has(key)) return false;
  if (observedReasoningModels.has(key)) return true;
  const declared = catalogReasoningSupport.get(key);
  if (declared !== undefined) return declared;
  const patterns = REASONING_PATTERNS[provider];
  if (patterns === undefined) return true;
  if (patterns.some((pattern) => pattern.test(model))) return true;
  return endpointAcceptedEfforts(provider) !== undefined;
}

export function displayReasoningEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
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

export function modelReasoningEfforts(
  provider: ProviderId,
  model: string,
): readonly string[] | undefined {
  loadLearnedCapabilities();
  const learned = catalogReasoningEfforts.get(reasoningKey(provider, model));
  if (learned?.length) return learned;
  const family = modelFamilyFor(model);
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
  controlDialect?: string,
): void {
  if (!model.trim()) return;
  persistLearnedRoute(reasoningKey(provider, model), {
    reasoning,
    ...(controlDialect ? { controlDialect } : {}),
  });
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
  const name = field.trim().toLowerCase();
  if (!name) return;
  const key = reasoningKey(provider, model);
  const existing = readLearnedRoute(key)?.rejectedFields ?? [];
  if (existing.includes(name)) return;
  persistLearnedRoute(key, { rejectedFields: [...existing, name] });
}

export function clearLearnedRouteCapabilities(): void {
  clearPersistedLearnedRoutes();
}

export { learnedRouteRejectedFields };

/**
 * Whether the given provider/model can accept image input. When true, the
 * agent attaches real image bytes to the user message; when false, it falls
 * back to a text note and OCR/inspection tools.
 */
export type VisionSupport = "yes" | "no" | "unknown";

export type VisionEvidence = "observed" | "pattern" | "none";

export function modelSupportsNativeTools(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): boolean {
  return resolveToolDialect(provider, model, toolCalling) !== "none";
}
