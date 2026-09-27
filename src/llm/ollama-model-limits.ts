import { modelCatalogFacts, registerModelCatalogLimits } from "./capabilities.js";
import type { CatalogFacts } from "./catalog-facts.js";

export const OLLAMA_MAX_NUM_CTX = 32_768;

const SHOW_TIMEOUT_MS = 4_000;
const SHOW_CONCURRENCY = 4;

const modelContextByDigest = new Map<string, number | null>();

interface OllamaTag {
  readonly name: string;
  readonly digest: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored > 0 ? floored : undefined;
}

function listedTags(payload: unknown): OllamaTag[] {
  const models = asRecord(payload)?.models;
  if (!Array.isArray(models)) return [];
  return models.flatMap((entry) => {
    const record = asRecord(entry);
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (!name) return [];
    return [{ name, digest: typeof record?.digest === "string" ? record.digest : "" }];
  });
}

export function ollamaTrainedContextLength(payload: unknown): number | undefined {
  const info = asRecord(asRecord(payload)?.model_info);
  if (!info) return undefined;
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith(".context_length")) continue;
    const tokens = positiveInteger(value);
    if (tokens !== undefined) return tokens;
  }
  return undefined;
}

async function fetchTrainedContextLength(
  endpoint: string,
  model: string,
): Promise<number | undefined> {
  try {
    const response = await fetch(`${endpoint}/api/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    });
    if (!response.ok) return undefined;
    return ollamaTrainedContextLength(await response.json());
  } catch {
    return undefined;
  }
}

async function trainedContextLength(
  endpoint: string,
  tag: OllamaTag,
): Promise<number | undefined> {
  const key = `${endpoint}\u0000${tag.name}\u0000${tag.digest}`;
  const cached = modelContextByDigest.get(key);
  if (cached !== undefined) return cached ?? undefined;
  const tokens = await fetchTrainedContextLength(endpoint, tag.name);
  if (tag.digest) modelContextByDigest.set(key, tokens ?? null);
  return tokens;
}

function servedLimits(model: string, trained: number | undefined): CatalogFacts {
  return {
    ...modelCatalogFacts("ollama", model),
    id: model,
    contextTokens: Math.min(trained ?? OLLAMA_MAX_NUM_CTX, OLLAMA_MAX_NUM_CTX),
    ...(trained !== undefined ? { nominalContextTokens: trained } : {}),
  };
}

export async function registerOllamaModelLimits(
  endpoint: string,
  tagsPayload: unknown,
): Promise<void> {
  const pending = listedTags(tagsPayload);
  const facts: CatalogFacts[] = [];
  const worker = async (): Promise<void> => {
    for (let tag = pending.shift(); tag; tag = pending.shift()) {
      facts.push(servedLimits(tag.name, await trainedContextLength(endpoint, tag)));
    }
  };
  await Promise.all(Array.from({ length: SHOW_CONCURRENCY }, worker));
  if (facts.length > 0) registerModelCatalogLimits("ollama", facts);
}

export function resetOllamaModelLimitsForTesting(): void {
  modelContextByDigest.clear();
}
