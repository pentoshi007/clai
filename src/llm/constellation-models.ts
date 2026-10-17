import type { CatalogModel } from "./capabilities.js";
import { catalogEffortList, catalogEntriesFromPayload, parseCatalogFacts } from "./catalog-facts.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function constellationModel(entry: unknown): CatalogModel | undefined {
  const parsed = parseCatalogFacts(entry);
  if (!parsed) return undefined;
  const item = record(entry);
  if (item?.type !== undefined && item.type !== "language" && item.type !== "multimodal")
    return undefined;
  if (/(?:embed|whisper|tts|moderation|dall-e)/i.test(parsed.id)) return undefined;
  const tags = Array.isArray(item?.tags)
    ? item.tags.filter((tag): tag is string => typeof tag === "string")
    : undefined;
  const verdict = record(record(item?.tool_shapes)?.function)?.verdict;
  const tools = verdict === "works" ? true : verdict === "fails" ? false
    : tags ? tags.includes("tool-use") : parsed.tools;
  const vision = parsed.vision ?? (tags ? tags.includes("vision") : undefined);
  const reasoning = parsed.reasoning ?? (tags ? { supported: tags.includes("reasoning") } : undefined);
  const canonical = item?.models_dev_id;
  const facts = {
    ...parsed,
    ...(typeof canonical === "string" && canonical.trim() ? { canonicalModel: canonical.trim() } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(vision !== undefined ? { vision } : {}),
    ...(tools !== undefined ? { tools } : {}),
  };
  return {
    id: facts.id,
    facts,
    vision,
    reasoning: reasoning?.supported,
    reasoningEfforts: catalogEffortList(reasoning?.supportedEfforts),
  };
}

export function constellationModelCatalog(payload: unknown): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of catalogEntriesFromPayload(payload)) {
    const model = constellationModel(entry);
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
