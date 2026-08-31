import { getConfig } from "../../store/config.js";
import { providerIds } from "../../types.js";
import type { ProviderId } from "../../types.js";
import {
  preferredVisionModels,
  universalVisionPatterns,
  visionPatterns,
} from "./vision-patterns.js";
import type { VisionEvidence, VisionSupport } from "../capabilities.js";
import {
  clearPersistedLearnedVision,
  persistLearnedVision,
} from "../learned-capabilities.js";
import {
  capabilityKey,
  configuredVisionModel,
  isSelectableModel,
  loadLearnedCapabilities,
  setLearnedLoaded,
  visionCapabilityCache,
  visionSubstitutions,
} from "./state.js";

export function visionSubstitutionOrigin(
  provider: ProviderId,
  substitute: string,
): string | undefined {
  const original = visionSubstitutions.get(capabilityKey(provider, substitute));
  return original &&
    original.trim().toLowerCase() !== substitute.trim().toLowerCase()
    ? original
    : undefined;
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

export function clearModelVisionCapabilities(): void {
  visionCapabilityCache.clear();
  setLearnedLoaded(false);
}

export function clearLearnedVisionCapabilities(): void {
  visionCapabilityCache.clear();
  setLearnedLoaded(true);
  clearPersistedLearnedVision();
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
