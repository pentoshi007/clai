import { providerIds } from "../types.js";
import type { ProviderId } from "../types.js";
import type { ToolDialect, ToolCallingMode } from "./tool-protocol.js";
import { isTextOnlyModel } from "./tool-protocol.js";
import {
  getConfig,
  updateConfig,
  type LearnedVisionEntry,
} from "../store/config.js";

// Patterns of model names that support an explicit reasoning/thinking
// toggle. The match is case-insensitive substring or regex.
const reasoningPatterns: Record<ProviderId, RegExp[]> = {
  free: [/deepseek/i, /kimi/i, /minimax/i, /mimo/i, /nemotron/i],
  groq: [/qwen\/qwen3-32b/i, /gpt-oss/i],
  gemini: [/gemini-2\.5/i, /gemini-3/i, /gemini-3\.5/i],
  openrouter: [
    /:thinking/i,
    /deepseek-r1/i,
    /qwen3/i,
    /kimi-k2/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /gpt-5/i,
    /o[134]/i,
    /grok.*reasoner/i,
  ],
  openai: [/gpt-5/i, /o1/i, /o3/i, /o4/i],
  anthropic: [/claude-(?:opus|sonnet|haiku)-(?:3-7|4|4-\d)/i, /claude-3-7/i],
  nvidia: [
    /kimi-k2/i,
    /deepseek-r1/i,
    /deepseek-v[34]/i,
    /qwen3/i,
    /nemotron/i,
    /glm-?5/i,
    /gpt-oss/i,
  ],
  ollama: [/deepseek-r1/i, /qwen3/i, /qwq/i],
  agentrouter: [
    /gpt-5/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /deepseek-(?:v[34]|r1)/i,
    /glm-?[45]/i,
    /qwen3/i,
    /kimi-k2/i,
    /o[134]/i,
  ],
  kimchi: [/kimi-k2/i, /minimax-m2/i, /minimax-m3/i, /nemotron-3-super/i],
  "aws-mantle": [/claude-(?:opus|sonnet|haiku)-4/i],
  bynara: [/kimi/i, /deepseek/i, /agnes/i, /stepfun/i],
  "qwen-cloud": [/qwen3/i, /qwen2/i],
  // Modal Endpoints serve the open-weight catalog (Kimi, Qwen, DeepSeek, GLM,
  // Gemma, GPT-OSS, Nemotron); the thinking families among them are matched by
  // their repo id, which is also the model name on the wire.
  modal: [
    /kimi/i,
    /qwen3/i,
    /deepseek/i,
    /glm-?[45]/i,
    /gpt-oss/i,
    /nemotron/i,
    /gemma-?[34]/i,
  ],
  // Lightning AI proxies vendor models under namespaced ids (openai/gpt-5,
  // anthropic/claude-opus-4-8, google/gemini-3.5-flash, lightning-ai/...).
  lightning: [
    /gpt-5/i,
    /o[134](?:-mini)?\b/i,
    /claude-(?:opus|sonnet|haiku)-4/i,
    /claude-fable/i,
    /gemini-3/i,
    /gemini-2\.5/i,
    /deepseek/i,
    /gpt-oss/i,
    /nemotron/i,
  ],
  // TokenRouter documents reasoning support for every model it serves.
  tokenrouter: [
    /kimi/i,
    /deepseek/i,
    /qwen3/i,
    /glm-?5/i,
    /gpt-oss/i,
    /minimax/i,
  ],
  meta: [/muse-spark/i],
};

// Session-sticky set of provider/model routes that rejected our
// reasoning/thinking options at runtime. Populated by the router when a
// provider returns a parameter-rejection error for a reasoning knob.
const reasoningUnsupportedModels = new Set<string>();

const reasoningKey = (provider: ProviderId, model: string): string =>
  `${provider}:${model.trim().toLowerCase()}`;

/** Mark a model as having rejected reasoning options so we stop sending them. */
export function markReasoningUnsupported(provider: ProviderId, model: string): void {
  reasoningUnsupportedModels.add(reasoningKey(provider, model));
}

/** Whether a model was observed to reject reasoning options this session. */
export function isReasoningUnsupported(provider: ProviderId, model: string): boolean {
  return reasoningUnsupportedModels.has(reasoningKey(provider, model));
}

export function clearReasoningUnsupported(): void {
  reasoningUnsupportedModels.clear();
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
  | "unknown";

export function modelReasoningEvidence(
  provider: ProviderId,
  model: string,
): ReasoningEvidence {
  const key = reasoningKey(provider, model);
  if (reasoningUnsupportedModels.has(key)) return "rejected";
  if (observedReasoningModels.has(key)) return "observed";
  if (catalogReasoningSupport.has(key)) return "catalog";
  const patterns = reasoningPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model)) ? "pattern" : "unknown";
}

export function resetReasoningKnowledge(): void {
  reasoningUnsupportedModels.clear();
  catalogReasoningSupport.clear();
  observedReasoningModels.clear();
  catalogReasoningEfforts.clear();
}

export function modelSupportsThinking(
  provider: ProviderId,
  model: string,
): boolean {
  const key = reasoningKey(provider, model);
  if (reasoningUnsupportedModels.has(key)) return false;
  if (observedReasoningModels.has(key)) return true;
  const declared = catalogReasoningSupport.get(key);
  if (declared !== undefined) return declared;
  const patterns = reasoningPatterns[provider] ?? [];
  return patterns.some((pattern) => pattern.test(model));
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
  groq: [
    // Llama 4 (scout/maverick) and llama-3.2 vision models on Groq.
    /llama-4/i,
    /llama-3\.2-(?:11b|90b)-vision/i,
    /meta-llama\/llama-4/i,
  ],
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
  kimchi: [/kimi-k2/i, /minimax-m2/i, /minimax-m3/i, /nemotron-3-super/i],
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
}

const catalogReasoningEfforts = new Map<string, readonly string[]>();

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
  return catalogReasoningEfforts.get(reasoningKey(provider, model));
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
  if (knownProviderIds.has(provider)) return;
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

const NEGATIVE_CAPABILITY_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_LEARNED_CAPABILITIES = 400;

function readLearnedEntry(
  entry: LearnedVisionEntry | undefined,
): { vision: boolean; at: number } | undefined {
  if (typeof entry === "boolean") return { vision: entry, at: 0 };
  if (!entry || typeof entry.vision !== "boolean") return undefined;
  const at = typeof entry.at === "string" ? Date.parse(entry.at) : Number.NaN;
  return { vision: entry.vision, at: Number.isFinite(at) ? at : 0 };
}

function negativeIsStale(at: number): boolean {
  return Date.now() - at > NEGATIVE_CAPABILITY_TTL_MS;
}

function loadLearnedVisionCapabilities(): void {
  if (learnedLoaded) return;
  learnedLoaded = true;
  let learned: Record<string, LearnedVisionEntry> | undefined;
  try {
    learned = getConfig().learnedVisionCapabilities;
  } catch {
    return;
  }
  if (!learned) return;
  for (const [key, raw] of Object.entries(learned)) {
    if (visionCapabilityCache.has(key)) continue;
    const entry = readLearnedEntry(raw);
    if (!entry) continue;
    if (!entry.vision && negativeIsStale(entry.at)) continue;
    visionCapabilityCache.set(key, {
      vision: entry.vision,
      source: "provider",
      observedAt: new Date(entry.at).toISOString(),
    });
  }
}

export function learnModelVisionCapability(
  provider: ProviderId,
  model: string,
  vision: boolean,
): void {
  loadLearnedVisionCapabilities();
  const key = capabilityKey(provider, model);
  const existing = visionCapabilityCache.get(key);
  registerModelVisionCapability({ provider, model, vision });
  if (existing?.vision === vision && existing.source === "provider") return;
  try {
    const learned = { ...(getConfig().learnedVisionCapabilities ?? {}) };
    const current = readLearnedEntry(learned[key]);
    if (current?.vision === vision && (vision || !negativeIsStale(current.at))) {
      return;
    }
    learned[key] = { vision, at: new Date().toISOString() };
    updateConfig({ learnedVisionCapabilities: pruneLearned(learned) });
  } catch {
  }
}

function pruneLearned(
  learned: Record<string, LearnedVisionEntry>,
): Record<string, LearnedVisionEntry> {
  const live: Record<string, LearnedVisionEntry> = {};
  for (const [key, raw] of Object.entries(learned)) {
    const entry = readLearnedEntry(raw);
    if (!entry) continue;
    if (!entry.vision && negativeIsStale(entry.at)) continue;
    live[key] = raw;
  }
  const keys = Object.keys(live);
  if (keys.length <= MAX_LEARNED_CAPABILITIES) return live;
  const trimmed: Record<string, LearnedVisionEntry> = {};
  for (const key of keys.slice(keys.length - MAX_LEARNED_CAPABILITIES)) {
    trimmed[key] = live[key]!;
  }
  return trimmed;
}

export function clearModelVisionCapabilities(): void {
  visionCapabilityCache.clear();
  learnedLoaded = false;
}

export function clearLearnedVisionCapabilities(): void {
  visionCapabilityCache.clear();
  learnedLoaded = true;
  try {
    updateConfig({ learnedVisionCapabilities: {} });
  } catch {
  }
}

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
  loadLearnedVisionCapabilities();
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
  loadLearnedVisionCapabilities();
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
  groq: "meta-llama/llama-4-scout-17b-16e-instruct",
  gemini: "gemini-3.5-flash",
  openrouter: "google/gemini-2.5-flash",
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  nvidia: "meta/llama-4-maverick-17b-128e-instruct",
  agentrouter: "claude-opus-4-6",
  kimchi: "kimi-k2.6",
  "aws-mantle": "anthropic.claude-haiku-4-5",
  ollama: "llama3.2-vision",
  bynara: "mimo-v2.5-free",
  "qwen-cloud": "qwen3.7-plus",
  lightning: "google/gemini-3.5-flash",
  tokenrouter: "kimi-k2p6",
  meta: "muse-spark-1.2",
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
  groq: "openai",
  openrouter: "openai",
  nvidia: "openai",
  agentrouter: "openai",
  kimchi: "openai",
  bynara: "openai",
  "qwen-cloud": "openai",
  modal: "openai",
  lightning: "openai",
  tokenrouter: "openai",
  meta: "openai",
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

  return providerToolDialect[provider] ?? "none";
}

export function modelSupportsNativeTools(
  provider: ProviderId,
  model: string,
  toolCalling?: ToolCallingMode,
): boolean {
  return resolveToolDialect(provider, model, toolCalling) !== "none";
}
