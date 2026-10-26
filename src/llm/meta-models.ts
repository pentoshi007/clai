import type { CatalogReasoningFacts } from "./catalog-facts.js";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function documentedMetaReasoning(model: string): CatalogReasoningFacts | undefined {
  const id = model.trim().toLowerCase();
  if (/^(?:muse-image-1\.0|muse-voice-transcribe-1\.0|sam-3\.1)$/.test(id)) {
    return { supported: false, mandatory: false, supportedEfforts: [] };
  }
  if (!/^(?:muse-wonder-1\.0|muse-spark-1\.[123](?:-contributor)?)$/.test(id)) return undefined;
  const supportsMax = id === "muse-wonder-1.0" || id === "muse-spark-1.3";
  return {
    supported: true,
    mandatory: true,
    supportedEfforts: supportsMax ? EFFORTS : EFFORTS.slice(0, -1),
  };
}

export function metaModelReasoning(
  model: string,
  published?: CatalogReasoningFacts,
): CatalogReasoningFacts | undefined {
  const documented = documentedMetaReasoning(model);
  if (!published) return documented;
  if (published.supported === false) {
    return { ...published, supported: false, mandatory: false, supportedEfforts: [] };
  }
  const efforts = published.supportedEfforts;
  return {
    ...documented,
    ...published,
    ...(Array.isArray(efforts) && published.mandatory === undefined
      ? { mandatory: efforts.length > 0 && !efforts.includes("none") }
      : {}),
  };
}
