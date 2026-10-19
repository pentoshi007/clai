import { createHash } from "node:crypto";
import { FREEBUFF_API_BASE_URL } from "./freebuff-auth.js";
import {
  freebuffDeviceHeaders,
  freebuffForgetDeviceKeyRegistration,
  isFreebuffDeviceKeyError,
} from "./freebuff-device-key.js";

const CATALOG_PATH = "/api/v1/freebuff/models";
export const FREEBUFF_CATALOG_PROTOCOL = "1";
export const FREEBUFF_CATALOG_PROTOCOL_HEADER = "x-freebuff-catalog-protocol";
export const FREEBUFF_CATALOG_FETCH_HEADER = "x-freebuff-catalog-fetch";
export const FREEBUFF_CATALOG_CLIENT = "cli";

const CACHE_TTL_MS = 30 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 20_000;
const MAX_CACHED_ACCOUNTS = 10;

export const FREEBUFF_STATIC_MODEL_IDS: readonly string[] = [
  "anthropic/claude-fable-5.1",
  "anthropic/claude-opus-4.8",
  "anthropic/claude-opus-5",
  "anthropic/claude-opus-5.5",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-sonnet-5",
  "crof/kimi-k3-eco",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4.1-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.6-flash",
  "google/gemini-3.7-flash",
  "google/gemini-3.8-flash",
  "meta-llama/llama-4-maverick",
  "meta/muse-spark-1.2-contributor",
  "meta/muse-spark-1.3-contributor",
  "mimo/mimo-v2.5",
  "mimo/mimo-v2.5-pro",
  "mimo/mimo-v2.6-pro",
  "minimax/minimax-m3",
  "mistralai/codestral-2508",
  "mistralai/mistral-large",
  "moonshotai/kimi-k3",
  "openai/gpt-5.4-pro",
  "openai/gpt-5.5",
  "openai/gpt-5.5-pro",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-luna-es",
  "openai/gpt-5.6-luna-pro",
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-sol-pro",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-terra-pro",
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-pro",
  "openai/gpt-6-luna",
  "openai/gpt-6-luna-pro",
  "openai/gpt-6-sol",
  "openai/gpt-6-sol-pro",
  "openai/o3-pro",
  "qwen/qwen3.6-max-preview",
  "qwen/qwen3.6-plus",
  "qwen/qwen3.7-max",
  "qwen/qwen3.7-plus",
  "qwen/qwen3.8-27b",
  "qwen/qwen3.8-flash",
  "qwen/qwen3.8-max-0902",
  "qwen/qwen3.8-max-prime",
  "stealth/ox-alpha",
  "stealth/space-bunny-alpha",
  "x-ai/grok-4.20",
  "x-ai/grok-4.5",
  "x-ai/grok-4.6",
  "x-ai/grok-4.7",
  "z-ai/glm-5-turbo",
  "z-ai/glm-5.2",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "z-ai/glm-5.3-flashx",
  "z-ai/glm-5.3-prime",
];

export interface FreebuffCatalogRow {
  readonly key: string;
  readonly handle: string;
  readonly access: string | undefined;
  readonly opensAt: number | undefined;
}

export interface FreebuffCatalogSnapshot {
  readonly version: string | undefined;
  readonly fetchId: string | undefined;
  readonly rows: readonly FreebuffCatalogRow[];
}

interface CachedCatalog {
  readonly snapshot: FreebuffCatalogSnapshot;
  readonly fetchedAt: number;
}

export interface FreebuffCatalogDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly baseUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

const cached = new Map<string, CachedCatalog>();
const requestsInFlight = new Map<string, Promise<FreebuffCatalogSnapshot | null>>();

function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function catalogUrl(base: string): string {
  return `${base.replace(/\/$/, "")}${CATALOG_PATH}`;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseSnapshot(payload: unknown): FreebuffCatalogSnapshot | null {
  const record = recordOf(payload);
  if (!record || record.protocol !== 1 || !Array.isArray(record.rows)) return null;
  const rows: FreebuffCatalogRow[] = [];
  for (const raw of record.rows) {
    const row = recordOf(raw);
    const key = row?.key;
    const handle = row?.handle;
    if (typeof key !== "string" || !key.trim() || typeof handle !== "string" || !handle.trim()) continue;
    rows.push({
      key: key.trim(),
      handle: handle.trim(),
      access: typeof row?.access === "string" ? row.access : undefined,
      opensAt: typeof row?.opensAt === "number" && Number.isFinite(row.opensAt) ? row.opensAt : undefined,
    });
  }
  return {
    version: typeof record.version === "string" ? record.version : undefined,
    fetchId: typeof record.fetchId === "string" ? record.fetchId : undefined,
    rows,
  };
}

function cacheSnapshot(tokenHash: string, snapshot: FreebuffCatalogSnapshot, fetchedAt: number): void {
  cached.delete(tokenHash);
  cached.set(tokenHash, { snapshot, fetchedAt });
  if (cached.size > MAX_CACHED_ACCOUNTS) {
    const oldest = cached.keys().next().value;
    if (oldest) cached.delete(oldest);
  }
}

function pruneStaleEntries(now: number): void {
  for (const [key, entry] of cached) {
    if (now - entry.fetchedAt >= CACHE_TTL_MS) cached.delete(key);
  }
}

async function requestCatalog(
  token: string,
  deps: FreebuffCatalogDeps,
  signal: AbortSignal | undefined,
  register: boolean,
): Promise<FreebuffCatalogSnapshot | null> {
  const url = catalogUrl(deps.baseUrl ?? FREEBUFF_API_BASE_URL);
  const timeout = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    [FREEBUFF_CATALOG_PROTOCOL_HEADER]: FREEBUFF_CATALOG_PROTOCOL,
    "x-freebuff-client": FREEBUFF_CATALOG_CLIENT,
    "user-agent": "Bun/1.3.14",
    accept: "*/*",
    "accept-encoding": "gzip, deflate, br",
  };
  const current = cached.get(tokenCacheKey(token))?.snapshot;
  Object.assign(
    headers,
    await freebuffDeviceHeaders({
      token,
      method: "GET",
      url,
      ...(current?.fetchId !== undefined ? { fetchId: current.fetchId } : {}),
      register,
    }),
  );
  const response = await (deps.fetch ?? fetch)(url, { method: "GET", headers, signal: combined });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    const error = (recordOf(payload)?.error);
    if (typeof error === "string") {
      if (isFreebuffDeviceKeyError(error)) freebuffForgetDeviceKeyRegistration(token, url);
    }
    return null;
  }
  return parseSnapshot(await response.json().catch(() => null));
}

async function loadCatalog(
  token: string,
  deps: FreebuffCatalogDeps,
  signal: AbortSignal | undefined,
  force: boolean,
): Promise<FreebuffCatalogSnapshot | null> {
  const tokenHash = tokenCacheKey(token);
  const now = deps.now?.() ?? Date.now();
  pruneStaleEntries(now);
  const previous = cached.get(tokenHash);
  if (!force && previous && now - previous.fetchedAt < CACHE_TTL_MS) return previous.snapshot;
  const inflight = requestsInFlight.get(tokenHash);
  if (inflight) return inflight;
  const request = (async (): Promise<FreebuffCatalogSnapshot | null> => {
    try {
      const snapshot = await requestCatalog(token, deps, signal, Boolean(previous));
      if (snapshot) cacheSnapshot(tokenHash, snapshot, deps.now?.() ?? Date.now());
      return snapshot ?? previous?.snapshot ?? null;
    } catch {
      return previous?.snapshot ?? null;
    }
  })();
  requestsInFlight.set(tokenHash, request);
  try {
    return await request;
  } finally {
    if (requestsInFlight.get(tokenHash) === request) requestsInFlight.delete(tokenHash);
  }
}

export function freebuffCatalogSnapshot(
  token: string,
  deps: FreebuffCatalogDeps = {},
): FreebuffCatalogSnapshot | undefined {
  const now = deps.now?.() ?? Date.now();
  pruneStaleEntries(now);
  return cached.get(tokenCacheKey(token))?.snapshot;
}

export function freebuffCatalogHandle(
  token: string,
  model: string,
  deps: FreebuffCatalogDeps = {},
): string | undefined {
  const snapshot = freebuffCatalogSnapshot(token, deps);
  return snapshot?.rows.find((row) => row.key === model)?.handle;
}

export function refreshFreebuffCatalog(
  token: string,
  signal?: AbortSignal,
  deps: FreebuffCatalogDeps = {},
): Promise<FreebuffCatalogSnapshot | null> {
  return loadCatalog(token, deps, signal, true);
}

export function visibleFreebuffCatalogModelIds(snapshot: FreebuffCatalogSnapshot, now = Date.now()): string[] {
  const ids = new Set<string>();
  for (const row of snapshot.rows) {
    if (row.access === "locked") continue;
    if (row.opensAt !== undefined && row.opensAt > now) continue;
    ids.add(row.key);
  }
  return [...ids];
}

export function mergeFreebuffModelIds(visible: readonly string[]): string[] {
  const merged = new Set<string>(FREEBUFF_STATIC_MODEL_IDS);
  for (const id of visible) {
    const trimmed = id.trim();
    if (trimmed) merged.add(trimmed);
  }
  return [...merged].sort((a, b) => a.localeCompare(b));
}

export function freebuffStaticModelIds(): string[] {
  return mergeFreebuffModelIds([]);
}

export function resetFreebuffCatalogCache(): void {
  cached.clear();
  requestsInFlight.clear();
}

export async function fetchFreebuffModelIds(
  token: string,
  signal?: AbortSignal,
  deps: FreebuffCatalogDeps = {},
): Promise<string[]> {
  const snapshot = await loadCatalog(token, deps, signal, false);
  const ids = snapshot ? visibleFreebuffCatalogModelIds(snapshot).sort((a, b) => a.localeCompare(b)) : [];
  return ids.length > 0 ? ids : freebuffStaticModelIds();
}
