import type { ProviderId } from "../../types.js";

const CATALOG_VISION_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "mistral",
  "river",
  "constellation",
  "hinoki",
  "refuseless",
  "unrestricted",
  "unaligned",
]);

const CATALOG_MANDATORY_REASONING_PROVIDERS: ReadonlySet<ProviderId> =
  new Set<ProviderId>(["cline", "river", "hinoki", "refuseless", "silkcompute"]);

const CATALOG_REASONING_SUPPORT_PROVIDERS: ReadonlySet<string> = new Set<ProviderId>([
  "cline",
  "meta",
  "unaligned",
]);

const CATALOG_EFFORT_LAYER_PROVIDERS: ReadonlySet<ProviderId> = new Set<ProviderId>([
  "refuseless",
  "silkcompute",
]);

export function catalogDeclaresVision(provider: ProviderId): boolean {
  return CATALOG_VISION_PROVIDERS.has(provider);
}

export function catalogDeclaresMandatoryReasoning(
  provider: ProviderId,
): boolean {
  return CATALOG_MANDATORY_REASONING_PROVIDERS.has(provider);
}

export function catalogDeclaresReasoningSupport(provider: string): boolean {
  return CATALOG_REASONING_SUPPORT_PROVIDERS.has(provider);
}

export function catalogDrivesEffortLayer(provider: ProviderId): boolean {
  return CATALOG_EFFORT_LAYER_PROVIDERS.has(provider);
}
