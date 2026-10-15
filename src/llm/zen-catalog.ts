import { readBodyCapped } from "./wire/response-errors.js";

const CATALOG_URL = "https://models.opencode.ai/api.json";
const CATALOG_PROVIDER = "opencode";
const CACHE_TTL_MS = 30 * 60 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

interface CatalogSnapshot {
  readonly freeIds: readonly string[];
  readonly fetchedAt: number;
}

let snapshot: CatalogSnapshot | undefined;
let nextAttemptAt = 0;
let pending: Promise<void> | undefined;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isFreeCatalogModel(model: unknown): boolean {
  const record = asRecord(model);
  const cost = asRecord(record?.cost);
  return cost?.input === 0 && cost?.output === 0 && record?.status !== "deprecated";
}

export function freeZenIdsFromCatalog(payload: unknown): string[] {
  const models = asRecord(asRecord(asRecord(payload)?.[CATALOG_PROVIDER])?.models);
  if (!models) return [];
  return Object.entries(models)
    .filter(([, model]) => isFreeCatalogModel(model))
    .map(([id]) => id);
}

async function fetchCatalogPayload(): Promise<unknown> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const response = await fetch(CATALOG_URL, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`OpenCode catalog responded ${response.status}`);
  return JSON.parse(await readBodyCapped(response, MAX_CATALOG_BYTES, signal));
}

async function refreshSnapshot(): Promise<void> {
  nextAttemptAt = Date.now() + RETRY_COOLDOWN_MS;
  try {
    const freeIds = freeZenIdsFromCatalog(await fetchCatalogPayload());
    snapshot = { freeIds, fetchedAt: Date.now() };
    nextAttemptAt = 0;
  } catch {}
}

export async function listFreeZenCatalogIds(): Promise<readonly string[] | undefined> {
  const fresh = snapshot !== undefined && Date.now() - snapshot.fetchedAt < CACHE_TTL_MS;
  if (!fresh && Date.now() >= nextAttemptAt) {
    pending ??= refreshSnapshot().finally(() => {
      pending = undefined;
    });
    await pending;
  }
  const ids = snapshot?.freeIds ?? [];
  return ids.length > 0 ? ids : undefined;
}

export function isZenCatalogFreeIdCached(id: string): boolean {
  return snapshot?.freeIds.includes(id.trim().toLowerCase()) ?? false;
}

export function resetZenCatalogForTesting(): void {
  snapshot = undefined;
  nextAttemptAt = 0;
  pending = undefined;
}
