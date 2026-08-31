import type { SearchProviderId } from "../../tools/web/types.js";
import type { ProviderStatus } from "../../types.js";
import { getSecret, SecretSource, setSecret, unsetSecret } from "./secret-store.js";

/**
 * Env-var name used for a search provider's API key, per Requirement 3.3.
 * Returns `undefined` for keyless providers (DuckDuckGo).
 */
export const searchProviderEnvVars: Record<SearchProviderId, string | undefined> = {
  brave: 'BRAVE_SEARCH_API_KEY',
  tavily: 'TAVILY_API_KEY',
  duckduckgo: undefined,
  exa: 'EXA_API_KEY',
};

/** One stored API key slot for an LLM provider. */
export interface ProviderKeySlot {
  readonly id: string;
  readonly value: string;
  readonly createdAt: number;
  readonly disabled?: boolean | undefined;
}

/** Resolved multi-key view for a provider (storage or env). */
export interface ProviderKeysResult {
  readonly keys: ProviderKeySlot[];
  /** Sticky index used as the next rotation start (clamped). */
  readonly activeIndex: number;
  readonly source: ProviderStatus['source'];
}

/** On-disk multi-key payload stored as JSON under `llm:<provider>`. */
interface ProviderKeysEnvelopeV1 {
  v: 1;
  keys: Array<{ id: string; value: string; createdAt: number; disabled?: boolean }>;
  activeIndex: number;
}

export const MAX_PROVIDER_KEYS = 10;

export function newKeyId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function clampActiveIndex(index: number, len: number): number {
  if (len <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  const i = Math.floor(index);
  if (i < 0) return 0;
  if (i >= len) return len - 1;
  return i;
}

function isEnvelopeV1(value: unknown): value is ProviderKeysEnvelopeV1 {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  if (rec.v !== 1 || !Array.isArray(rec.keys)) return false;
  return rec.keys.every(
    (k) =>
      k &&
      typeof k === 'object' &&
      typeof (k as { id?: unknown }).id === 'string' &&
      typeof (k as { value?: unknown }).value === 'string' &&
      typeof (k as { createdAt?: unknown }).createdAt === 'number',
  );
}

/**
 * Parse a stored secret string into slots. Legacy plain API keys become a
 * single-slot list. Invalid JSON that looks like a key is treated as legacy.
 */
export function parseProviderKeysPayload(
  raw: string | undefined,
): { keys: ProviderKeySlot[]; activeIndex: number } {
  if (!raw || !raw.trim()) {
    return { keys: [], activeIndex: 0 };
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isEnvelopeV1(parsed) && parsed.keys.length > 0) {
        const keys = parsed.keys
          .map((k) => ({
            id: k.id || newKeyId(),
            value: k.value,
            createdAt: k.createdAt || Date.now(),
            ...(k.disabled === true ? { disabled: true } : {}),
          }))
          .filter((k) => k.value.trim().length > 0)
          .slice(0, MAX_PROVIDER_KEYS);
        return {
          keys,
          activeIndex: clampActiveIndex(parsed.activeIndex ?? 0, keys.length),
        };
      }
    } catch {
      // Fall through to legacy single-string treatment.
    }
  }
  return {
    keys: [{ id: newKeyId(), value: trimmed, createdAt: Date.now() }],
    activeIndex: 0,
  };
}

export function serializeProviderKeysPayload(
  keys: readonly ProviderKeySlot[],
  activeIndex: number,
): string {
  const cleaned = keys
    .map((k) => ({
      id: k.id || newKeyId(),
      value: k.value.trim(),
      createdAt: k.createdAt || Date.now(),
      ...(k.disabled === true ? { disabled: true } : {}),
    }))
    .filter((k) => k.value.length > 0)
    .slice(0, MAX_PROVIDER_KEYS);
  const envelope: ProviderKeysEnvelopeV1 = {
    v: 1,
    keys: cleaned,
    activeIndex: clampActiveIndex(activeIndex, cleaned.length),
  };
  return JSON.stringify(envelope);
}

/**
 * Resolve every API key for a keyed search provider.
 *
 * This intentionally mirrors LLM key semantics: stored multi/single keys
 * win over an ambient environment variable, and an environment value is only
 * a synthetic single-key fallback when nothing has been stored. DuckDuckGo
 * is keyless and therefore never exposes stored key slots.
 */
export async function getSearchProviderKeys(
  id: SearchProviderId,
): Promise<ProviderKeysResult> {
  if (id === 'duckduckgo') {
    return { keys: [], activeIndex: 0, source: 'missing' };
  }

  const stored = await getSecret('search', id);
  if (stored.value) {
    const parsed = parseProviderKeysPayload(stored.value);
    if (parsed.keys.length > 0) {
      return {
        keys: parsed.keys,
        activeIndex: parsed.activeIndex,
        source: stored.source,
      };
    }
  }

  const envVar = searchProviderEnvVars[id];
  const env = envVar ? process.env[envVar] : undefined;
  if (env && env.length > 0) {
    return {
      keys: [{ id: 'env', value: env, createdAt: 0 }],
      activeIndex: 0,
      source: 'env',
    };
  }

  return { keys: [], activeIndex: 0, source: 'missing' };
}

/** Resolve the sticky active key for compatibility with single-key callers. */
export async function getSearchProviderKey(
  id: SearchProviderId,
): Promise<{ value?: string; source: SecretSource }> {
  const multi = await getSearchProviderKeys(id);
  if (multi.keys.length === 0) return { source: multi.source };
  const index = clampActiveIndex(multi.activeIndex, multi.keys.length);
  return { value: multi.keys[index]!.value, source: multi.source };
}

/** Replace all stored keys for a search provider (the shared keys editor). */
export async function setSearchProviderKeys(
  id: SearchProviderId,
  values: readonly string[],
  activeIndex = 0,
  disabledValues?: readonly string[],
): Promise<'keychain' | 'fallback'> {
  if (id === 'duckduckgo') return 'fallback';
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of cleaned) {
    if (seen.has(value)) continue;
    seen.add(value);
    unique.push(value);
    if (unique.length >= MAX_PROVIDER_KEYS) break;
  }
  if (unique.length === 0) {
    await unsetSecret('search', id);
    return 'fallback';
  }
  let carried = disabledValues;
  if (carried === undefined) {
    const stored = await getSecret('search', id);
    carried = stored.value
      ? parseProviderKeysPayload(stored.value)
          .keys.filter((k) => k.disabled)
          .map((k) => k.value)
      : [];
  }
  const disabledSet = new Set(carried);
  const now = Date.now();
  const slots: ProviderKeySlot[] = unique.map((value) => ({
    id: newKeyId(),
    value,
    createdAt: now,
    ...(disabledSet.has(value) ? { disabled: true } : {}),
  }));
  return setSecret('search', id, serializeProviderKeysPayload(slots, activeIndex));
}

/** Append a search API key, preserving the existing sticky active key. */
export async function appendSearchProviderKey(
  id: SearchProviderId,
  secret: string,
): Promise<'keychain' | 'fallback'> {
  if (id === 'duckduckgo') return 'fallback';
  const trimmed = secret.trim();
  if (!trimmed) throw new Error('empty API key');

  const current = await getSearchProviderKeys(id);
  // Like LLM providers, saving any explicit key replaces env-only resolution.
  const base = current.source === 'env' ? [] : current.keys.map((key) => ({ ...key }));
  if (base.some((key) => key.value === trimmed)) {
    const index = base.findIndex((key) => key.value === trimmed);
    return setSecret(
      'search',
      id,
      serializeProviderKeysPayload(base, index >= 0 ? index : current.activeIndex),
    );
  }
  if (base.length >= MAX_PROVIDER_KEYS) {
    throw new Error(`at most ${MAX_PROVIDER_KEYS} API keys per provider`);
  }
  base.push({ id: newKeyId(), value: trimmed, createdAt: Date.now() });
  return setSecret(
    'search',
    id,
    serializeProviderKeysPayload(base, base.length === 1 ? 0 : current.activeIndex),
  );
}

export async function unsetSearchProviderSecret(id: SearchProviderId): Promise<void> {
  if (id !== 'duckduckgo') await unsetSecret('search', id);
}

export async function setSearchProviderKeyDisabled(
  id: SearchProviderId,
  value: string,
  disabled: boolean,
): Promise<boolean> {
  if (id === 'duckduckgo') return false;
  const stored = await getSecret('search', id);
  if (!stored.value) return false;
  const parsed = parseProviderKeysPayload(stored.value);
  const target = value.trim();
  const index = parsed.keys.findIndex((k) => k.value === target);
  if (index < 0) return false;
  const keys = parsed.keys.map((k, i) => {
    if (i !== index) return k;
    const { disabled: _ignored, ...rest } = k;
    return disabled ? { ...rest, disabled: true } : rest;
  });
  await setSecret('search', id, serializeProviderKeysPayload(keys, parsed.activeIndex));
  return true;
}

/** Persist the key that last completed a search successfully as the sticky key. */
export async function markSearchProviderKeySuccess(
  id: SearchProviderId,
  index: number,
): Promise<void> {
  if (id === 'duckduckgo') return;
  const stored = await getSecret('search', id);
  if (!stored.value) return;
  const parsed = parseProviderKeysPayload(stored.value);
  if (parsed.keys.length === 0) return;
  const next = clampActiveIndex(index, parsed.keys.length);
  if (next === parsed.activeIndex && stored.value.trim().startsWith('{')) return;
  await setSecret('search', id, serializeProviderKeysPayload(parsed.keys, next));
}
