import { parseCatalogFacts } from "./catalog-facts.js";
import { readBodyCapped, readJson } from "./wire/response-errors.js";

const CATALOG_URL = "https://models.dev/api.json";
const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

interface ModelLimits {
  readonly contextTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
}

let limits: ReadonlyMap<string, ModelLimits> = new Map();
let nextFetchAt = 0;
let pending: Promise<ReadonlyMap<string, ModelLimits>> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function zenModelLimits(payload: unknown): ReadonlyMap<string, ModelLimits> {
  const provider = asRecord(asRecord(payload)?.opencode);
  const models = asRecord(provider?.models);
  if (
    typeof provider?.api !== "string" ||
    provider.api.replace(/\/+$/, "") !== ZEN_BASE_URL ||
    !models
  ) {
    throw new Error("OpenCode Zen model limits are unavailable");
  }
  const result = new Map<string, ModelLimits>();
  for (const [id, value] of Object.entries(models)) {
    const model = asRecord(value);
    if (!model || (model.id !== undefined && model.id !== id)) continue;
    const facts = parseCatalogFacts({ id, limit: model.limit });
    if (facts?.contextTokens === undefined && facts?.maxOutputTokens === undefined)
      continue;
    result.set(id, {
      contextTokens: facts?.contextTokens,
      maxOutputTokens: facts?.maxOutputTokens,
    });
  }
  return result;
}

async function loadZenModelLimits(): Promise<ReadonlyMap<string, ModelLimits>> {
  if (pending) return pending;
  if (Date.now() < nextFetchAt) return limits;
  const task = (async () => {
    try {
      const signal = AbortSignal.timeout(10_000);
      const response = await fetch(CATALOG_URL, {
        headers: { "user-agent": "clai", accept: "application/json" },
        signal,
      });
      const payload: unknown = response.ok
        ? JSON.parse(await readBodyCapped(response, MAX_CATALOG_BYTES, signal))
        : await readJson<unknown>(response, signal);
      limits = zenModelLimits(payload);
      nextFetchAt = Date.now() + CACHE_TTL_MS;
    } catch {
      nextFetchAt = Date.now() + FAILURE_RETRY_MS;
    }
    return limits;
  })();
  pending = task;
  try {
    return await task;
  } finally {
    pending = undefined;
  }
}

export async function supplementZenModelLimits(
  entries: readonly unknown[],
): Promise<readonly unknown[]> {
  const facts = entries.map(parseCatalogFacts);
  if (
    !facts.some(
      (entry) =>
        entry &&
        (entry.contextTokens === undefined || entry.maxOutputTokens === undefined),
    )
  ) {
    return entries;
  }
  const supplemental = await loadZenModelLimits();
  return entries.map((entry, index) => {
    const observed = facts[index];
    if (!observed) return entry;
    const published = supplemental.get(observed.id);
    if (!published) return entry;
    const contextTokens =
      observed.contextTokens === undefined ? published.contextTokens : undefined;
    const maxOutputTokens =
      observed.maxOutputTokens === undefined ? published.maxOutputTokens : undefined;
    if (contextTokens === undefined && maxOutputTokens === undefined) return entry;
    return {
      ...asRecord(entry),
      id: observed.id,
      ...(contextTokens === undefined ? {} : { context_length: contextTokens }),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
    };
  });
}
