import type { CatalogModel } from "./capabilities.js";
import {
  catalogEffortList,
  catalogEntriesFromPayload,
  parseCatalogFacts,
  type CatalogFacts,
} from "./catalog-facts.js";

export const RIVER_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
export const RIVER_GLM_MODEL = "zai-org/GLM-5.3-Flash";

export function documentedRiverModelFacts(model: string): CatalogFacts | undefined {
  const id = model.trim().toLowerCase();
  if (
    id !== RIVER_DEFAULT_MODEL.toLowerCase() &&
    id !== `${RIVER_DEFAULT_MODEL}-1017`.toLowerCase() &&
    id !== RIVER_GLM_MODEL.toLowerCase()
  ) return undefined;
  const mandatory = id === RIVER_GLM_MODEL.toLowerCase();
  return {
    id: model,
    contextTokens: 1_048_576,
    maxOutputTokens: mandatory ? 128_000 : 384_000,
    vision: true,
    tools: true,
    modalities: ["text", "image"],
    reasoning: {
      supported: true,
      mandatory,
      supportedEfforts: mandatory ? ["low", "high", "max"] : ["none", "high", "max"],
    },
  };
}

export function riverModelFacts(
  model: string,
  live?: CatalogFacts,
): CatalogFacts | undefined {
  const documented = documentedRiverModelFacts(model);
  if (!live) return documented;
  const efforts = catalogEffortList(live.reasoning?.supportedEfforts);
  const reasoning = live.reasoning?.supported === false
    ? { supported: false, mandatory: false, supportedEfforts: [] }
    : {
        ...documented?.reasoning,
        ...live.reasoning,
        ...(efforts && live.reasoning?.mandatory === undefined
          ? { mandatory: !efforts.includes("none") }
          : {}),
      };
  return {
    ...documented,
    ...live,
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function toolSupport(entry: unknown): boolean | undefined {
  const raw = record(entry);
  const caps = record(raw?.capabilities);
  for (const value of [raw?.tools, raw?.supports_tools, caps?.function_calling, caps?.tools]) {
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

export function riverModelCatalog(payload: unknown): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of catalogEntriesFromPayload(payload)) {
    const parsed = parseCatalogFacts(entry);
    if (!parsed) continue;
    const tools = toolSupport(entry);
    const facts = riverModelFacts(parsed.id, {
      ...parsed,
      ...(tools !== undefined ? { tools } : {}),
    })!;
    const reasoningEfforts = catalogEffortList(facts.reasoning?.supportedEfforts);
    models.set(parsed.id, {
      id: parsed.id,
      facts,
      ...(facts.vision !== undefined ? { vision: facts.vision } : {}),
      ...(facts.reasoning?.supported !== undefined
        ? { reasoning: facts.reasoning.supported }
        : {}),
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
    });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id));
}
