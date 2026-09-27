import { parseCatalogFacts } from "../catalog-facts.js";

const MODEL_DATA_URL = "https://www.orcarouter.ai/api/public/models";
const CACHE_TTL_MS = 30 * 60 * 1000;
const FAILURE_RETRY_MS = 60 * 1000;
const MAX_CONCURRENT_REQUESTS = 4;

type CachedMetadata = { entry: Record<string, unknown> | null; fetchedAt: number; ttlMs: number };
const metadataCache = new Map<string, CachedMetadata>();

export function resetOrcaRouterModelMetadataCache(): void {
  metadataCache.clear();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function modelId(entry: unknown): string {
  if (typeof entry === "string") return entry.trim();
  const id = asRecord(entry)?.id;
  return typeof id === "string" ? id.trim() : "";
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

async function publicModelMetadata(id: string): Promise<Record<string, unknown> | undefined> {
  const separator = id.indexOf("/");
  if (separator <= 0 || separator === id.length - 1) return undefined;
  const provider = id.slice(0, separator);
  const slug = id.slice(separator + 1);
  const url = `${MODEL_DATA_URL}/${encodeURIComponent(provider)}/${encodeURIComponent(slug)}`;
  const now = Date.now();
  const cached = metadataCache.get(id.toLowerCase());
  if (cached && now - cached.fetchedAt < cached.ttlMs) return cached.entry ?? undefined;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      metadataCache.set(id.toLowerCase(), { entry: null, fetchedAt: now, ttlMs: FAILURE_RETRY_MS });
      return undefined;
    }
    const body: unknown = await response.json();
    const data = asRecord(asRecord(body)?.data);
    const context = positiveInteger(data?.context_window);
    const output = positiveInteger(data?.max_output);
    if (context === undefined && output === undefined) {
      metadataCache.set(id.toLowerCase(), { entry: null, fetchedAt: now, ttlMs: FAILURE_RETRY_MS });
      return undefined;
    }
    const entry = {
      id,
      ...(context !== undefined ? { context_window: context } : {}),
      ...(output !== undefined ? { max_output_tokens: output } : {}),
    };
    metadataCache.set(id.toLowerCase(), { entry, fetchedAt: now, ttlMs: CACHE_TTL_MS });
    return entry;
  } catch {
    metadataCache.set(id.toLowerCase(), { entry: null, fetchedAt: now, ttlMs: FAILURE_RETRY_MS });
    return undefined;
  }
}

export async function enrichOrcaRouterModelEntries(
  entries: readonly unknown[],
): Promise<unknown[]> {
  const enriched = [...entries];
  const seen = new Set<string>();
  const pending = entries.flatMap((entry, index) => {
    const id = modelId(entry);
    if (!id || seen.has(id.toLowerCase()) || parseCatalogFacts(entry)?.contextTokens) return [];
    seen.add(id.toLowerCase());
    return [{ entry, id, index }];
  });
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const current = next++;
      const candidate = pending[current];
      if (!candidate) return;
      const metadata = await publicModelMetadata(candidate.id);
      if (!metadata) continue;
      const raw = asRecord(candidate.entry) ?? {};
      enriched[candidate.index] = { ...raw, ...metadata, id: candidate.id };
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENT_REQUESTS, pending.length) },
    () => worker(),
  ));
  return enriched;
}
