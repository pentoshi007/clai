import { parseCatalogFacts, type CatalogFacts, type CatalogReasoningFacts } from "./catalog-facts.js";

export const SARVAM_BASE_URL = "https://api.sarvam.ai/v2";

export const SARVAM_MODELS = [
  "glm5.3-flash",
  "glm5.3",
  "gemma4",
  "deepseekv4.1-flash-1017",
  "deepseekv4.1-flash-1017-interactive",
  "sarvam-105b",
  "sarvam-105b-conversations",
] as const;

const GLM_EFFORTS = ["low", "high", "max"];
const DEEPSEEK_EFFORTS = ["none", ...GLM_EFFORTS];

interface PublishedModel {
  readonly contextTokens: number;
  readonly vision: boolean;
  readonly efforts?: readonly string[];
  readonly defaultEffort?: string;
}

const deepSeekFlash: PublishedModel = {
  contextTokens: 1_048_576,
  vision: true,
  efforts: DEEPSEEK_EFFORTS,
  defaultEffort: "high",
};

const MODELS = new Map<string, PublishedModel>([
  ["glm5.3", { contextTokens: 1_048_576, vision: false, efforts: GLM_EFFORTS, defaultEffort: "max" }],
  ["glm5.3-flash", { contextTokens: 1_048_576, vision: true, efforts: GLM_EFFORTS, defaultEffort: "high" }],
  ["gemma4", { contextTokens: 262_144, vision: true, efforts: ["none", ...GLM_EFFORTS] }],
  ["deepseekv4.1-flash-1017", deepSeekFlash],
  ["deepseekv4.1-flash-1017-interactive", deepSeekFlash],
  ["deepseekv4-pro", { contextTokens: 1_000_000, vision: false, efforts: DEEPSEEK_EFFORTS, defaultEffort: "high" }],
  ["kimi-k3.1-pro", { contextTokens: 1_048_576, vision: true, efforts: ["low", "medium", "high", "max"], defaultEffort: "max" }],
  ["qwen38-27b", { contextTokens: 262_144, vision: true, efforts: ["none"] }],
  ["sarvam-105b", { contextTokens: 128_000, vision: false, efforts: ["none", "low", "medium", "high"], defaultEffort: "low" }],
  ["sarvam-105b-conversations", { contextTokens: 32_000, vision: false }],
]);

export function sarvamWireApi(): "chat-completions" | "responses" {
  return process.env.SARVAM_WIRE_API?.trim().toLowerCase() === "responses"
    ? "responses"
    : "chat-completions";
}

function publishedReasoning(model: string, entry: PublishedModel): CatalogReasoningFacts {
  const efforts = entry.efforts;
  if (!efforts) {
    return { supported: false, mandatory: false, supportedEfforts: [] };
  }
  return {
    supported: true,
    mandatory: !efforts.includes("none"),
    supportedEfforts: efforts,
    defaultEnabled: Boolean(entry.defaultEffort) || model === "qwen38-27b",
    defaultEffort: entry.defaultEffort,
  };
}

function responseEfforts(model: string, efforts: readonly string[]): readonly string[] {
  if (model === "gemma4" || model === "glm5.3-flash") {
    return efforts.filter((effort) => effort !== "max");
  }
  if (model.startsWith("deepseekv4")) {
    return efforts.filter((effort) => effort !== "medium");
  }
  return efforts;
}

export function sarvamOmitsEffort(model: string, effort: string): boolean {
  return (model === "gemma4" && effort === "none") ||
    (sarvamWireApi() === "responses" && model === "glm5.3" && effort === "max");
}

export function sarvamModelFacts(model: string, live?: CatalogFacts): CatalogFacts | undefined {
  const published = MODELS.get(model);
  if (!published && !live) return undefined;
  const fallback = published ? publishedReasoning(model, published) : undefined;
  const advertised = live?.reasoning;
  const responses = sarvamWireApi() === "responses";
  const reasoning = responses && model === "sarvam-105b"
    ? { supported: false, mandatory: false, supportedEfforts: [] } as const
    : advertised || fallback ? { ...fallback, ...advertised } : undefined;
  const efforts = reasoning?.supportedEfforts;
  const supportedEfforts = reasoning?.supported === false ? []
    : responses && Array.isArray(efforts)
      ? responseEfforts(model, efforts)
      : efforts;
  return {
    ...(published ? { contextTokens: published.contextTokens, vision: published.vision, tools: true } : {}),
    ...live,
    id: model,
    ...(reasoning ? {
      reasoning: {
        ...reasoning,
        supportedEfforts,
        mandatory: reasoning.supported === false || advertised?.defaultEnabled === false ||
          (Array.isArray(efforts) && efforts.includes("none"))
          ? false
          : reasoning.mandatory,
      },
    } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function parseSarvamModel(entry: unknown): CatalogFacts | undefined {
  const raw = asRecord(entry);
  if (typeof raw?.id !== "string" || raw.id.trim() !== raw.id || !raw.id) return undefined;
  if (typeof raw.type === "string" && raw.type !== "chat") return undefined;
  const facts = parseCatalogFacts(raw);
  if (!facts) return undefined;
  const caps = asRecord(raw.capabilities);
  const support = asRecord(caps?.supports);
  const tools = [raw.supports_tools, raw.tools, caps?.tools, caps?.function_calling, support?.function_calling]
    .find((value): value is boolean => typeof value === "boolean");
  const reasoning = asRecord(raw.reasoning);
  const advertisedEfforts = Array.isArray(reasoning?.efforts)
    ? reasoning.efforts.filter((effort): effort is string => typeof effort === "string")
    : undefined;
  const canDisable = typeof reasoning?.can_disable === "boolean" ? reasoning.can_disable : undefined;
  const efforts = advertisedEfforts ?? facts.reasoning?.supportedEfforts;
  const supportedEfforts = canDisable === true && Array.isArray(efforts)
    ? [...new Set(["none", ...efforts])]
    : efforts;
  const defaultEnabled = typeof reasoning?.default_on === "boolean" ? reasoning.default_on : undefined;
  const toolChoices = Array.isArray(raw.tool_choices)
    ? raw.tool_choices.filter((choice): choice is string => typeof choice === "string")
    : undefined;
  return {
    ...facts,
    id: raw.id,
    ...(tools !== undefined ? { tools } : {}),
    ...(toolChoices !== undefined ? { toolChoices } : {}),
    ...(facts.reasoning ? {
      reasoning: {
        ...facts.reasoning,
        supportedEfforts,
        ...(canDisable !== undefined ? { mandatory: !canDisable } : {}),
        ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
      },
    } : {}),
  };
}

export function mergeSarvamModelFacts(list: CatalogFacts, detail?: CatalogFacts): CatalogFacts {
  if (!detail) return list;
  return {
    ...list,
    ...detail,
    tools: detail.tools ?? list.tools,
    reasoning: list.reasoning || detail.reasoning
      ? { ...list.reasoning, ...detail.reasoning }
      : undefined,
  };
}

export function sarvamReasoningEfforts(facts: CatalogFacts | undefined): readonly string[] | undefined {
  const efforts = facts?.reasoning?.supportedEfforts;
  if (facts?.reasoning?.supported === false) return [];
  return Array.isArray(efforts) ? efforts : undefined;
}
