import { providerIds } from "../types.js";
import type {
  ProviderId,
  ReasoningEffort,
  ReasoningPreference,
} from "../types.js";
import type { ToolDialect, ToolCallingMode } from "./tool-protocol.js";
import { isTextOnlyModel } from "./tool-protocol.js";
import type { CatalogFacts } from "./catalog-facts.js";
import { modelFamilyFor } from "./model-families.js";
import {
  endpointAcceptedEfforts,
  REASONING_PATTERNS,
} from "./reasoning-capability.js";
import {
  clampEffortToRoute,
  clearRouteDialectRegistry,
  forgetNegativeControlDialect,
  negativeLearnedUnderAnotherDialect,
  routeControlDialect,
  setNegativeControlDialect,
  setRouteControlDialect,
} from "./route-dialect-registry.js";
import { getConfig } from "../store/config.js";
import type { LearnedRouteEntry } from "../store/config.js";
import {
  clearPersistedLearnedRoutes,
  clearPersistedLearnedVision,
  learnedRouteAt,
  learnedRouteCapabilities,
  learnedRouteRejectedFields,
  learnedVisionCapabilities,
  negativeIsStale,
  clearPersistedLearnedRouteReasoning,
  persistLearnedRoute,
  persistLearnedVision,
  readLearnedRoute,
  readLearnedVisionEntry,
  UNATTRIBUTED_CONTROL_DIALECT,
} from "./learned-capabilities.js";


// Session-sticky set of provider/model routes that rejected our
// reasoning/thinking options at runtime. Populated by the router when a
// provider returns a parameter-rejection error for a reasoning knob.
const reasoningUnsupportedModels = new Set<string>();

const reasoningKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model.trim().toLowerCase()}`;

/** Mark a model as having rejected reasoning options so we stop sending them. */
export function markReasoningUnsupported(provider: ProviderId, model: string): void {
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
export function isReasoningUnsupported(provider: ProviderId, model: string): boolean {
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
  return clampEffortToRoute(thinking.effort, displayReasoningEfforts(provider, model));
}

export function registerRouteAcceptedEfforts(
  provider: ProviderId,
  model: string,
  efforts: readonly string[],
): void {
  if (!model.trim() || efforts.length === 0) return;
  catalogReasoningEfforts.set(reasoningKey(provider, model), [...efforts]);
}

const catalogReasoningSupport = new Map<string, boolean>();
const observedReasoningModels = new Set<string>();

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
  | "rejected"
  | "observed"
  | "catalog"
  | "pattern"
  | "endpoint"
  | "unknown";

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

export function resetReasoningKnowledge(): void {
  reasoningUnsupportedModels.clear();
  catalogReasoningSupport.clear();
  observedReasoningModels.clear();
  catalogReasoningEfforts.clear();
  catalogFactsByRoute.clear();
  clearRouteDialectRegistry();
  learnedLoaded = true;
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


const universalVisionPatterns: RegExp[] = [
  /(?:^|[-/_.])vision(?:$|[-_.])/i,
  /(?:^|[-/_.])vl(?:$|[-_.])/i,
  /multimodal/i,
  /omni(?:$|[-_.])/i,
  /llava/i,
  /bakllava/i,
  /moondream/i,
  /minicpm-?v/i,
  /internvl/i,
  /pixtral/i,
  /paligemma/i,
  /florence-2/i,
  /molmo/i,
  /kosmos/i,
  /fuyu/i,
  /idefics/i,
  /aya-vision/i,
  /granite.*vision/i,
  /smolvlm/i,
  /llama-?4/i,
  /llama-?3\.2-(?:11b|90b)/i,
  /gemma-?[34](?!\D*\b1b)/i,
  /qwen-?vl/i,
  /qwen\d*(?:\.\d+)?-?vl/i,
  /gpt-4o/i,
  /gpt-4\.1/i,
  /gpt-4-turbo/i,
  /gpt-5/i,
  /gemini-/i,
  /claude-3(?:[-.]|$)/i,
  /claude-(?:opus|sonnet|haiku)-(?:[3-9]|\d{2,})/i,
  /grok-(?:[4-9]|\d{2,})/i,
  /mistral-(?:small|medium|large)-3/i,
  /magistral-(?:small|medium)/i,
  /phi-(?:4|5)-multimodal/i,
  /nova-(?:lite|pro|premier)/i,
  /step-1[ov]/i,
  /ernie-\d+(?:\.\d+)?-vl/i,
  /glm-4\.?\d*v/i,
  /kimi-k2\.\d/i,
  /kimi-k[3-9]/i,
];

const visionPatterns: Record<ProviderId, RegExp[]> = {
  free: [],
  gemini: [
    // All current Gemini models are natively multimodal.
    /gemini-/i,
  ],
  openrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /grok-(?:2-)?vision/i,
    /grok-4/i,
    /:vision/i,
  ],
  openai: [/gpt-4o/i, /gpt-4\.1/i, /gpt-5/i, /o[34]/i, /gpt-4-turbo/i],
  anthropic: [
    // Claude 3+ (opus/sonnet/haiku) are all vision-capable.
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
  ],
  nvidia: [
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /vila/i,
    /neva/i,
    /qwen2?\.?5?-vl/i,
    /pixtral/i,
    /gemma-3/i,
    /minimax-m3/i,
  ],
  ollama: [
    /llava/i,
    /llama3\.2-vision/i,
    /llama-?4/i,
    /bakllava/i,
    /moondream/i,
    /minicpm-?v/i,
    /qwen2?\.?5?-vl/i,
    /gemma3/i,
  ],
  agentrouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-(?:3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gemini-/i,
    /llama-4/i,
    /qwen2?\.?5?-vl/i,
    /glm-4\.?\d*v/i,
    /glm-?5/i,
  ],
  "aws-mantle": [
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-3(?:-|\.|$)/i,
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /gemini-/i,
    /llama-4/i,
    /qwen2?\.?5?-vl/i,
    /qwen-vl/i,
    /glm-4\.?\d*v/i,
    /glm-?5/i,
    /vision/i,
  ],
  bynara: [/mimo-v2\.5/i, /mistral-medium-3-5/i, /agnes-\d/i],
  "qwen-cloud": [/qwen3\.7-(?:plus|max)/i, /qwen3\.5-(?:plus|flash)/i, /qwen-vl/i],
  // Catalog endpoints are text-only apart from the explicitly multimodal repos.
  modal: [/-vl\b/i, /-vl-/i],
  // Per TokenRouter's model table: Kimi, Qwen and MiniMax M3 take images;
  // DeepSeek, GLM and GPT-OSS are text-only there.
  tokenrouter: [/kimi/i, /qwen3p\d/i, /minimax-m3/i],
  // Matches the input_modalities reported by lightning.ai/api/v1/models.
  lightning: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /o[34]\b/i,
    /claude-(?:opus|sonnet|haiku)-(?:3|3-5|3-7|4|4-\d)/i,
    /claude-fable/i,
    /gemini-/i,
    /gemma-4/i,
  ],
  meta: [/muse-spark/i],
  fireworks: [/kimi-k2/i, /qwen3.*vl/i, /qwen.*vl/i, /vision/i, /vl$/i, /llama-4/i, /pixtral/i, /glm-4.*v/i],
  hetzner: [/qwen/i, /vision/i, /vl/i],
  // Vision-capable ids per OrcaRouter's capability table: gpt-4o family,
  // gemini-2.5/3.x, grok-4, plus the routed Claude/Qwen-VL/Kimi families.
  orcarouter: [
    /gpt-4o/i,
    /gpt-4\.1/i,
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)/i,
    /gemini-/i,
    /grok-/i,
    /qwen.*vl/i,
    /kimi/i,
    /vision/i,
    /vl$/i,
  ],
};

const visionCapabilityCache = new Map<
  string,
  { vision: boolean; source: "provider" | "user"; observedAt: string }
>();

const capabilityKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model.trim().toLowerCase()}`;

const providerModelCatalog = new Map<ProviderId, Set<string>>();
const unavailableModels = new Set<string>();
const visionSubstitutions = new Map<string, string>();

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

const catalogReasoningEfforts = new Map<string, readonly string[]>();
const catalogFactsByRoute = new Map<string, CatalogFacts>();

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
  return catalogFactsByRoute.get(
    `${provider}:${model.trim().toLowerCase()}`,
  );
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

export function markModelUnavailable(provider: ProviderId, model: string): void {
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

export function visionSubstitutionOrigin(
  provider: ProviderId,
  substitute: string,
): string | undefined {
  const original = visionSubstitutions.get(capabilityKey(provider, substitute));
  return original && original.trim().toLowerCase() !== substitute.trim().toLowerCase()
    ? original
    : undefined;
}

export function clearProviderModelKnowledge(): void {
  providerModelCatalog.clear();
  unavailableModels.clear();
  visionSubstitutions.clear();
}

const knownProviderIds = new Set<string>(providerIds);
const warnedUnknownProviders = new Set<string>();

/**
 * Capability lookups are keyed by canonical `ProviderId`. Passing a display
 * label (`"NVIDIA NIM"`) used to silently resolve to "no capability", which
 * Disabled vision while the rest of the app believed it was on.
 * Fail loudly in dev/test and warn once per bad key in production.
 */
export function warnOnUnknownProviderId(site: string, provider: string): void {
  const configuredCustomProvider = (getConfig().customProviders ?? []).some(
    (definition) => definition.id === provider,
  );
  if (knownProviderIds.has(provider) || configuredCustomProvider) return;
  const message = `${site}: "${provider}" is not a canonical ProviderId — capability lookups will report no support. Pass the provider id, not the display label.`;
  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    throw new Error(message);
  }
  if (warnedUnknownProviders.has(provider)) return;
  warnedUnknownProviders.add(provider);
  console.warn(`[clai] ${message}`);
}

function configuredVisionModel(provider: ProviderId): string | undefined {
  const envKey = `CLAI_VISION_MODEL_${provider.toUpperCase().replace(/-/g, "_")}`;
  return process.env[envKey]?.trim() || undefined;
}

/** Provider discovery/user overrides can refresh capability knowledge at runtime. */
export function registerModelVisionCapability(input: {
  provider: ProviderId;
  model: string;
  vision: boolean;
  source?: "provider" | "user";
  observedAt?: string;
}): void {
  visionCapabilityCache.set(capabilityKey(input.provider, input.model), {
    vision: input.vision,
    source: input.source ?? "provider",
    observedAt: input.observedAt ?? new Date().toISOString(),
  });
}

let learnedLoaded = false;

function loadLearnedCapabilities(): void {
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
    if (!stale && entry.controlDialect) {
      reasoningUnsupportedModels.add(key);
      setNegativeControlDialect(key, entry.controlDialect);
    } else clearPersistedLearnedRouteReasoning(key);
  }
  if (entry.acceptedEfforts?.length) {
    catalogReasoningEfforts.set(
      key,
      entry.acceptedEfforts
        .map((effort: string) => effort.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  if (entry.contextTokens === undefined && entry.maxOutputTokens === undefined) {
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

export function learnModelVisionCapability(
  provider: ProviderId,
  model: string,
  vision: boolean,
): void {
  loadLearnedCapabilities();
  const key = capabilityKey(provider, model);
  const existing = visionCapabilityCache.get(key);
  registerModelVisionCapability({ provider, model, vision });
  if (existing?.vision === vision && existing.source === "provider") return;
  persistLearnedVision(key, vision);
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
  limits: { contextTokens?: number | undefined; maxOutputTokens?: number | undefined },
): void {
  if (limits.contextTokens === undefined && limits.maxOutputTokens === undefined) {
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

export function clearModelVisionCapabilities(): void {
  visionCapabilityCache.clear();
  learnedLoaded = false;
}

export function clearLearnedVisionCapabilities(): void {
  visionCapabilityCache.clear();
  learnedLoaded = true;
  clearPersistedLearnedVision();
}

export function clearLearnedRouteCapabilities(): void {
  clearPersistedLearnedRoutes();
}

export function reloadLearnedCapabilities(): void {
  learnedLoaded = false;
  loadLearnedCapabilities();
}

export { learnedRouteRejectedFields };

export function visionCapabilitySource(
  provider: ProviderId,
  model: string,
): "provider" | "user" | "fallback-table" {
  const cached = visionCapabilityCache.get(capabilityKey(provider, model));
  if (cached) return cached.source;
  const configured = configuredVisionModel(provider);
  return configured?.toLowerCase() === model.trim().toLowerCase()
    ? "user"
    : "fallback-table";
}

/**
 * Whether the given provider/model can accept image input. When true, the
 * agent attaches real image bytes to the user message; when false, it falls
 * back to a text note and OCR/inspection tools.
 */
export type VisionSupport = "yes" | "no" | "unknown";

export type VisionEvidence = "observed" | "pattern" | "none";

export function visionEvidence(
  provider: ProviderId,
  model: string,
): VisionEvidence {
  loadLearnedCapabilities();
  if (visionCapabilityCache.has(capabilityKey(provider, model))) {
    return "observed";
  }
  return modelVisionSupport(provider, model) === "yes" ? "pattern" : "none";
}

export function modelVisionSupport(
  provider: ProviderId,
  model: string,
): VisionSupport {
  warnOnUnknownProviderId("modelVisionSupport", provider);
  loadLearnedCapabilities();
  const cached = visionCapabilityCache.get(capabilityKey(provider, model));
  if (cached) return cached.vision ? "yes" : "no";
  const configured = configuredVisionModel(provider);
  if (configured?.toLowerCase() === model.trim().toLowerCase()) return "yes";
  const normalizedModel = model.trim().replace(/\s+/g, "-");
  const matches = (pattern: RegExp): boolean =>
    pattern.test(model) || pattern.test(normalizedModel);
  if ((visionPatterns[provider] ?? []).some(matches)) return "yes";
  if (universalVisionPatterns.some(matches)) return "yes";
  return "unknown";
}

export function modelSupportsVision(
  provider: ProviderId,
  model: string,
): boolean {
  return modelVisionSupport(provider, model) === "yes";
}

export function modelAcceptsImages(
  provider: ProviderId,
  model: string,
): boolean {
  return modelVisionSupport(provider, model) !== "no";
}


const preferredVisionModels: Partial<Record<ProviderId, string>> = {
  gemini: "gemini-3.5-flash",
  openrouter: "google/gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "meta/llama-4-maverick-17b-128e-instruct",
  agentrouter: "claude-opus-4-6",
  "aws-mantle": "anthropic.claude-haiku-4-5",
  ollama: "llama3.2-vision",
  bynara: "mimo-v2.5-free",
  "qwen-cloud": "qwen3.7-plus",
  lightning: "google/gemini-3.5-flash",
  tokenrouter: "moonshotai/kimi-k2.7-code",
  meta: "muse-spark-1.2",
  fireworks: "accounts/fireworks/models/kimi-k2p6",
  hetzner: "Qwen/Qwen3.6-35B-A3B-FP8",
  orcarouter: "openai/gpt-4o-mini",
};


function isSelectableModel(provider: ProviderId, model: string): boolean {
  if (isModelUnavailable(provider, model)) return false;
  return providerModelIsKnown(provider, model) !== false;
}

export function preferredVisionModel(
  provider: ProviderId,
  currentModel: string,
): string | undefined {
  if (modelSupportsVision(provider, currentModel)) return currentModel;
  const override = configuredVisionModel(provider);
  if (override && modelSupportsVision(provider, override)) return override;
  const discovered = [...visionCapabilityCache.entries()]
    .filter(([key, value]) => key.startsWith(`${provider}:`) && value.vision)
    .sort((a, b) => b[1].observedAt.localeCompare(a[1].observedAt))
    .map(([key]) => key.slice(provider.length + 1))
    .find((model) => isSelectableModel(provider, model));
  if (discovered) return discovered;
  const fallback = preferredVisionModels[provider];
  if (!fallback) return undefined;
  if (!modelSupportsVision(provider, fallback)) return undefined;
  return isSelectableModel(provider, fallback) ? fallback : undefined;
}

/** Default wire dialect for each provider. */
const providerToolDialect: Record<ProviderId, ToolDialect> = {
  free: "openai",
  openai: "openai",
  openrouter: "openai",
  nvidia: "openai",
  agentrouter: "openai",
  bynara: "openai",
  "qwen-cloud": "openai",
  modal: "openai",
  lightning: "openai",
  tokenrouter: "openai",
  meta: "openai",
  fireworks: "openai",
  hetzner: "openai",
  orcarouter: "openai",
  anthropic: "anthropic",
  "aws-mantle": "openai", // refined by model below
  gemini: "gemini",
  ollama: "ollama",
};

/** Known non-tool / embedding / tiny models (light denylist). */
const nativeToolsDenylist: RegExp[] = [
  /embed/i,
  /embedding/i,
  /whisper/i,
  /tts/i,
  /dall-e/i,
  /moderation/i,
  /text-embedding/i,
];

/** Ollama families known to support tools. */
const ollamaToolFamilies: RegExp[] = [
  /llama3\.1/i,
  /llama3\.2/i,
  /llama3\.3/i,
  /llama-?4/i,
  /qwen/i,
  /mistral/i,
  /command-r/i,
  /firefunction/i,
  /tool/i,
  /nemotron/i,
  /deepseek/i,
  /gpt-oss/i,
  /gemma3/i,
];

function isAwsMantleAnthropicModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}


/** Tool capability a custom provider declared in its validated profile. */
function customToolCapability(provider: ProviderId): "supported" | "unsupported" | "unknown" {
  const def = (getConfig().customProviders ?? []).find(
    (definition) => definition.id === provider,
  );
  return def?.profile?.tools ?? "unknown";
}

export function resolveToolDialect(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): ToolDialect {
  const mode = toolCalling ?? getConfig().toolCalling ?? "auto";
  if (mode === "text") return "none";
  if (isTextOnlyModel(provider, model)) return "none";
  if (nativeToolsDenylist.some((re) => re.test(model))) return "none";

  if (provider === "aws-mantle") {
    return isAwsMantleAnthropicModel(model) ? "anthropic" : "openai";
  }

  if (provider === "ollama") {
    if (mode === "native") return "ollama";
    // native-preferred: only attach for known tool-capable families
    if (ollamaToolFamilies.some((re) => re.test(model))) return "ollama";
    return "none";
  }

  if (providerToolDialect[provider] === undefined) {
    // Custom routes serialize native tools only when declared supported;
    // unknown stays conservative so an undeclared server never receives
    // optional tool fields it may reject.
    return customToolCapability(provider) === "supported" ? "openai" : "none";
  }

  return providerToolDialect[provider] ?? "none";
}

export function modelSupportsNativeTools(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): boolean {
  return resolveToolDialect(provider, model, toolCalling) !== "none";
}
