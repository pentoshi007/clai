import {
  parseCatalogFacts,
  type CatalogFacts,
  type CatalogReasoningFacts,
} from "./catalog-facts.js";
import { readBodyCapped } from "./wire/response-errors.js";

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_TTL_MS = 30 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 60 * 1000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

interface SupplementalCatalog {
  readonly exact: ReadonlyMap<string, CatalogFacts>;
  readonly slugs: ReadonlyMap<string, CatalogFacts | undefined>;
}

let catalog: SupplementalCatalog = { exact: new Map(), slugs: new Map() };
let nextFetchAt = 0;
let nextAttemptAt = 0;
let pending: Promise<SupplementalCatalog> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function positiveTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  return values.find((value): value is boolean => typeof value === "boolean");
}

function reasoningFacts(
  entry: Record<string, unknown>,
  parsed: CatalogReasoningFacts | undefined,
): CatalogReasoningFacts | undefined {
  const nested = asRecord(entry.reasoning);
  const caps = asRecord(entry.capabilities);
  const supported = firstBoolean(
    entry.supportsReasoning,
    nested?.supported,
    entry.reasoning,
    caps?.reasoning,
    parsed?.supported,
  );
  if (supported === false) return { supported: false, supportedEfforts: [] };
  const options = entry.reasoning_options ?? entry.reasoningOptions;
  const shaped = Array.isArray(options)
    ? options.map(asRecord).filter(Boolean)
    : undefined;
  const efforts = parsed?.supportedEfforts;
  const toggle = shaped?.some((option) => option?.type === "toggle");
  const disable = toggle || (Array.isArray(efforts) && efforts.includes("none"));
  const facts: CatalogReasoningFacts = {
    ...parsed,
    ...(supported === undefined ? {} : { supported }),
    ...(shaped === undefined ? {} : {
      supportedEfforts: efforts ?? [],
      ...(nested?.mandatory === undefined && supported === true
        ? { mandatory: !disable }
        : {}),
    }),
  };
  return Object.keys(facts).length ? facts : undefined;
}

export function parseClineModelFacts(value: unknown): CatalogFacts | undefined {
  const entry = asRecord(value);
  const parsed = parseCatalogFacts(entry ? {
    ...entry,
    reasoning_options: entry.reasoning_options ?? entry.reasoningOptions,
  } : value);
  if (!parsed || !entry) return parsed;
  const limit = asRecord(entry.limit) ?? asRecord(entry.limits);
  const input = positiveTokens(entry.maxInputTokens) ?? positiveTokens(limit?.input);
  const context = input === undefined
    ? parsed.contextTokens
    : Math.min(input, parsed.contextTokens ?? input);
  const canonical = entry.canonical_model_id ?? entry.canonicalModel;
  const reasoning = reasoningFacts(entry, parsed.reasoning);
  const tools = firstBoolean(entry.supportsTools, entry.tool_call, entry.tools);
  const vision = firstBoolean(entry.supportsImages, parsed.vision);
  return {
    ...parsed,
    ...(typeof canonical === "string" && canonical.trim()
      ? { canonicalModel: canonical.trim() }
      : {}),
    ...(context === undefined ? {} : { contextTokens: context }),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(tools === undefined ? {} : { tools }),
    ...(vision === undefined ? {} : { vision }),
  };
}

function parseSupplementalCatalog(payload: unknown): SupplementalCatalog {
  const root = asRecord(payload);
  const exact = new Map<string, CatalogFacts>();
  const slugs = new Map<string, CatalogFacts | undefined>();
  let foundProvider = false;
  for (const [id, api] of [
    ["openrouter", "https://openrouter.ai/api/v1"],
    ["cline-pass", "https://api.cline.bot/api/v1"],
  ] as const) {
    const provider = asRecord(root?.[id]);
    const models = asRecord(provider?.models);
    if (
      typeof provider?.api !== "string" ||
      provider.api.replace(/\/+$/, "") !== api ||
      !models
    ) continue;
    foundProvider = true;
    for (const [modelId, value] of Object.entries(models)) {
      const entry = asRecord(value);
      if (!entry || (entry.id !== undefined && entry.id !== modelId)) continue;
      const facts = parseClineModelFacts({ ...entry, id: modelId });
      if (!facts) continue;
      exact.set(modelId, facts);
      if (id !== "openrouter") continue;
      const slug = modelId.split("/").at(-1)!;
      slugs.set(slug, slugs.has(slug) ? undefined : facts);
    }
  }
  if (!foundProvider) throw new Error("Cline model metadata is unavailable");
  return { exact, slugs };
}

function supplementalFacts(
  facts: CatalogFacts,
  source: SupplementalCatalog,
): CatalogFacts | undefined {
  return source.exact.get(facts.id)
    ?? (facts.canonicalModel ? source.exact.get(facts.canonicalModel) : undefined)
    ?? source.slugs.get(facts.id.split("/").at(-1)!);
}

async function loadSupplementalCatalog(
  refreshMissing: boolean,
): Promise<SupplementalCatalog> {
  if (pending) return pending;
  const now = Date.now();
  if (now < nextAttemptAt || (!refreshMissing && now < nextFetchAt)) return catalog;
  const task = (async () => {
    try {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetch(CATALOG_URL, {
        headers: { "user-agent": "clai", accept: "application/json" },
        signal,
      });
      if (!response.ok) {
        throw new Error(`Cline metadata lookup failed (HTTP ${response.status})`);
      }
      const payload: unknown = JSON.parse(await readBodyCapped(response, MAX_CATALOG_BYTES, signal));
      catalog = parseSupplementalCatalog(payload);
      nextFetchAt = Date.now() + CACHE_TTL_MS;
    } catch {
    } finally {
      nextAttemptAt = Date.now() + REFRESH_COOLDOWN_MS;
    }
    return catalog;
  })();
  pending = task;
  try {
    return await task;
  } finally {
    pending = undefined;
  }
}

function needsSupplement(facts: CatalogFacts): boolean {
  return facts.contextTokens === undefined || facts.maxOutputTokens === undefined ||
    facts.reasoning?.supported === undefined ||
    (facts.reasoning.supported && facts.reasoning.supportedEfforts === undefined) ||
    facts.vision === undefined || facts.tools === undefined;
}

function mergeFacts(
  observed: CatalogFacts,
  published: CatalogFacts | undefined,
): CatalogFacts {
  if (!published) return observed;
  const reasoning = observed.reasoning?.supported === false ? observed.reasoning : {
    ...published.reasoning,
    ...observed.reasoning,
    ...(observed.reasoning?.supportedEfforts !== undefined && observed.reasoning.mandatory === undefined
      ? { mandatory: undefined }
      : {}),
  };
  return {
    ...published,
    ...observed,
    id: observed.id,
    ...(Object.keys(reasoning).length ? { reasoning } : {}),
  };
}

export async function discoverClineModelFacts(
  entries: readonly unknown[],
): Promise<readonly CatalogFacts[]> {
  const observed = new Map<string, CatalogFacts>();
  for (const entry of entries) {
    const facts = parseClineModelFacts(entry);
    if (!facts) continue;
    const previous = observed.get(facts.id);
    observed.set(facts.id, previous ? mergeFacts(previous, facts) : facts);
  }
  const facts = [...observed.values()];
  const incomplete = facts.filter(needsSupplement);
  if (!incomplete.length) return facts;
  const refreshMissing = incomplete.some((entry) => !supplementalFacts(entry, catalog));
  const supplemental = await loadSupplementalCatalog(refreshMissing);
  return facts.map((entry) => mergeFacts(entry, supplementalFacts(entry, supplemental)));
}

export function resetClineModelMetadataCache(): void {
  catalog = { exact: new Map(), slugs: new Map() };
  nextFetchAt = 0;
  nextAttemptAt = 0;
  pending = undefined;
}
