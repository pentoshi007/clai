import type { CatalogModel } from "./capabilities.js";
import {
  catalogEffortList,
  catalogEntriesFromPayload,
  parseCatalogFacts,
  type CatalogFacts,
} from "./catalog-facts.js";

export const RIVER_DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
export const RIVER_GLM_MODEL = "zai-org/GLM-5.3-Flash";

export type RiverDocFacts = ReadonlyMap<string, CatalogFacts>;

interface DocumentedRiverModel {
  readonly id: string;
  readonly contextTokens: number;
  readonly maxOutputTokens: number;
  readonly vision: boolean;
  readonly efforts: readonly string[];
  readonly defaultEffort?: string;
}

const ONE_MILLION_CONTEXT = 1_048_576;

const DOCUMENTED_RIVER_MODELS: readonly DocumentedRiverModel[] = [
  {
    id: "moonshotai/Kimi-K3",
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 1_048_575,
    vision: true,
    efforts: ["none", "low", "high", "max"],
    defaultEffort: "max",
  },
  {
    id: "deepseek-ai/DeepSeek-V4.1-Flash",
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 393_216,
    vision: true,
    efforts: ["none", "low", "high", "max"],
  },
  {
    id: "deepseek-ai/DeepSeek-V4.1-Flash-1017",
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 393_216,
    vision: true,
    efforts: ["none", "low", "high", "max"],
  },
  {
    id: "nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4",
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 1_048_575,
    vision: true,
    efforts: ["none", "medium", "high"],
    defaultEffort: "high",
  },
  {
    id: RIVER_GLM_MODEL,
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 128_000,
    vision: true,
    efforts: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    id: "GLM-5.3",
    contextTokens: ONE_MILLION_CONTEXT,
    maxOutputTokens: 128_000,
    vision: false,
    efforts: ["low", "high", "max"],
    defaultEffort: "max",
  },
  {
    id: "Qwen/Qwen3.8-27B-FP8",
    contextTokens: 262_144,
    maxOutputTokens: 262_143,
    vision: true,
    efforts: ["none", "low", "medium", "xhigh"],
    defaultEffort: "xhigh",
  },
];

const documentedById = new Map(
  DOCUMENTED_RIVER_MODELS.map((model) => [model.id.toLowerCase(), model]),
);

export function isRiverDeepSeekModel(model: string): boolean {
  return /deepseek/i.test(model);
}

export function documentedRiverModelFacts(model: string): CatalogFacts | undefined {
  const documented = documentedById.get(model.trim().toLowerCase());
  if (!documented) return undefined;
  return {
    id: model,
    contextTokens: documented.contextTokens,
    maxOutputTokens: documented.maxOutputTokens,
    vision: documented.vision,
    tools: true,
    modalities: documented.vision ? ["text", "image"] : ["text"],
    reasoning: {
      supported: true,
      mandatory: !documented.efforts.includes("none"),
      supportedEfforts: documented.efforts,
      ...(documented.defaultEffort ? { defaultEffort: documented.defaultEffort } : {}),
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

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}

export function riverModelCatalog(payload: unknown, docs?: RiverDocFacts): CatalogModel[] {
  const models = new Map<string, CatalogModel>();
  for (const entry of catalogEntriesFromPayload(payload)) {
    const parsed = parseCatalogFacts(entry);
    if (!parsed) continue;
    const tools = toolSupport(entry);
    const fromDocs = docs?.get(parsed.id.toLowerCase());
    const facts = riverModelFacts(parsed.id, {
      ...fromDocs,
      ...withoutUndefined(parsed),
      id: parsed.id,
      ...(fromDocs?.reasoning || parsed.reasoning
        ? { reasoning: { ...fromDocs?.reasoning, ...parsed.reasoning } }
        : {}),
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
