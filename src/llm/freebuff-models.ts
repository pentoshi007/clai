import { createHash } from "node:crypto";
import { callFreebuffSession, type FreebuffSessionResponse } from "./freebuff-session-api.js";

export const FREEBUFF_CATALOG_VERSION = 1;

const CACHE_TTL_MS = 30 * 60 * 1000;

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

function collectKeys(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key.trim()) into.add(key.trim());
  }
}

function planRequiredIds(freebucks: unknown): Set<string> {
  const required = new Set<string>();
  const ids = (freebucks as { planRequiredModelIds?: unknown } | null | undefined)?.planRequiredModelIds;
  if (Array.isArray(ids)) {
    for (const id of ids) {
      if (typeof id === "string" && id.trim()) required.add(id.trim());
    }
  }
  return required;
}

function zeroPriceIds(freebucks: unknown): Set<string> {
  const free = new Set<string>();
  const prices = (freebucks as { prices?: unknown } | null | undefined)?.prices;
  if (!prices || typeof prices !== "object" || Array.isArray(prices)) return free;
  for (const [id, price] of Object.entries(prices as Record<string, unknown>)) {
    if (id.trim() && price === 0) free.add(id.trim());
  }
  return free;
}

export function visibleFreebuffModelIds(response: FreebuffSessionResponse): string[] {
  const record = response as {
    readonly model?: unknown;
    readonly rateLimitsByModel?: unknown;
    readonly freebucks?: unknown;
  };
  const blocked = planRequiredIds(record.freebucks);
  const ids = new Set<string>();
  if (typeof record.model === "string" && record.model.trim()) ids.add(record.model.trim());
  collectKeys(record.rateLimitsByModel, ids);
  for (const id of zeroPriceIds(record.freebucks)) ids.add(id);
  for (const id of blocked) ids.delete(id);
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

interface CachedCatalog {
  readonly tokenHash: string;
  readonly modelIds: readonly string[];
  readonly fetchedAt: number;
}

const cached = new Map<string, CachedCatalog>();
const requestsInFlight = new Map<string, Promise<string[]>>();
const MAX_CACHED_ACCOUNTS = 10;

export function resetFreebuffCatalogCache(): void {
  cached.clear();
  requestsInFlight.clear();
}

function tokenCacheKey(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function cacheCatalog(tokenHash: string, modelIds: readonly string[], fetchedAt: number): void {
  cached.delete(tokenHash);
  cached.set(tokenHash, { tokenHash, modelIds, fetchedAt });
  if (cached.size > MAX_CACHED_ACCOUNTS) {
    const oldest = cached.keys().next().value;
    if (oldest) cached.delete(oldest);
  }
}

export async function fetchFreebuffModelIds(
  token: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const tokenHash = tokenCacheKey(token);
  const now = Date.now();
  const previous = cached.get(tokenHash);
  if (previous && now - previous.fetchedAt < CACHE_TTL_MS) {
    cached.delete(tokenHash);
    cached.set(tokenHash, previous);
    return [...previous.modelIds];
  }
  const inFlight = requestsInFlight.get(tokenHash);
  if (inFlight) return [...(await inFlight)];

  const request = (async (): Promise<string[]> => {
    try {
      const response = await callFreebuffSession("GET", token, { signal });
      const visible = visibleFreebuffModelIds(response).sort((a, b) => a.localeCompare(b));
      const modelIds = visible.length > 0 ? visible : freebuffStaticModelIds();
      cacheCatalog(tokenHash, modelIds, Date.now());
      return modelIds;
    } catch {
      return previous ? [...previous.modelIds] : freebuffStaticModelIds();
    }
  })();
  requestsInFlight.set(tokenHash, request);
  try {
    return [...(await request)];
  } finally {
    if (requestsInFlight.get(tokenHash) === request) {
      requestsInFlight.delete(tokenHash);
    }
  }
}

export function freebuffStaticModelIds(): string[] {
  return mergeFreebuffModelIds([]);
}
