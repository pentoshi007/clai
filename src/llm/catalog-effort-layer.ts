import { catalogEffortList, type CatalogFacts } from "./catalog-facts.js";
import type { ProviderProfileLayer } from "./provider-profile.js";
import { WIRE_EFFORT_SCALE } from "./reasoning-controls.js";

export function openAiEffortCatalogLayer(
  facts: CatalogFacts | undefined,
): ProviderProfileLayer | undefined {
  const reasoning = facts?.reasoning;
  if (!reasoning) return undefined;
  const supported = reasoning.supported !== false;
  const efforts = supported
    ? catalogEffortList(reasoning.supportedEfforts) ?? WIRE_EFFORT_SCALE
    : [];
  const evidence = { source: "catalog" as const, confidence: "high" as const };
  return {
    evidence,
    reasoning: {
      generation: !supported
        ? "none"
        : reasoning.mandatory
          ? "mandatory"
          : reasoning.defaultEnabled
            ? "default-on"
            : "optional",
      control: {
        dialect: "openai-effort",
        status: supported ? "supported" : "unsupported",
        evidence,
      },
      acceptedEfforts: efforts,
      disable: reasoning.mandatory ? "unsupported" : "supported",
      disableForm: efforts.includes("none") ? "effort-none" : "omit-control",
    },
  };
}
