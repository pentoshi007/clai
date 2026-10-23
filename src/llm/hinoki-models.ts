import type { CatalogModel } from "./capabilities.js";
import { catalogEffortList, catalogEntriesFromPayload, parseCatalogFacts } from "./catalog-facts.js";

export const HINOKI_DEFAULT_MODEL = "hinoki-offensive";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolSupport(entry: Record<string, unknown> | undefined): boolean | undefined {
  const capabilities = record(entry?.capabilities);
  const supports = record(capabilities?.supports);
  for (const value of [supports?.tools, supports?.function_calling, capabilities?.tools,
    capabilities?.function_calling, entry?.supports_tools, entry?.supports_function_calling]) {
    if (typeof value === "boolean") return value;
  }
  if (Array.isArray(entry?.supported_parameters)) {
    return entry.supported_parameters.includes("tools");
  }
  return undefined;
}

export function hinokiModelCatalog(payload: unknown): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of catalogEntriesFromPayload(payload)) {
    const parsed = parseCatalogFacts(entry);
    if (!parsed || models.has(parsed.id)) continue;
    const item = record(entry);
    if (typeof item?.type === "string" && !["model", "language", "multimodal", "chat"].includes(item.type)) continue;
    if (/(?:embedding|whisper|tts|moderation|dall-e)/i.test(parsed.id)) continue;
    const known = parsed.id === HINOKI_DEFAULT_MODEL;
    const tools = toolSupport(item) ?? (known ? true : undefined);
    const vision = parsed.vision ?? (known ? true : undefined);
    const reasoning = parsed.reasoning ?? (known ? { supported: true } : undefined);
    const facts = {
      ...parsed,
      ...(tools !== undefined ? { tools } : {}),
      ...(vision !== undefined ? { vision } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
    models.set(parsed.id, {
      id: parsed.id,
      facts,
      vision,
      reasoning: reasoning?.supported,
      reasoningEfforts: catalogEffortList(reasoning?.supportedEfforts),
    });
  }
  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}
