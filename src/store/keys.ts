
import type { ProviderId, ProviderStatus } from '../types.js';
import { providerIds } from '../types.js';
import { getDefaultModel, getEnvVar, maskSecret } from '../llm/provider.js';
import {
  getActiveProviderEndpoint,
  getConfig,
  getProviderEndpoints,
  providerUsesEndpoints,
} from './config.js';
import type { SearchProviderId } from '../tools/web/types.js';
import { SecretSource, getSecret, isMissingKeychainError, keysFile, loadKeytar, serviceName, setKeychainRuntimeUnavailable, setSecret, unsetSecret } from "./keys/secret-store.js";
import { MAX_PROVIDER_KEYS, ProviderKeySlot, ProviderKeysResult, clampActiveIndex, newKeyId, parseProviderKeysPayload, searchProviderEnvVars, serializeProviderKeysPayload } from "./keys/search-providers.js";
export { appendSearchProviderKey, getSearchProviderKey, getSearchProviderKeys, markSearchProviderKeySuccess, setSearchProviderKeyDisabled, setSearchProviderKeys, unsetSearchProviderSecret } from "./keys/search-providers.js";
export { parseProviderKeysPayload, serializeProviderKeysPayload };
export type { ProviderKeySlot, ProviderKeysResult } from "./keys/search-providers.js";
export { secretAccount } from "./keys/secret-store.js";
export { getSecret, setSecret, unsetSecret };
export type { SecretNamespace, SecretSource } from "./keys/secret-store.js";

export function getFallbackKeysPath(): string {
  return keysFile;
}

export function searchProviderEnvVar(id: SearchProviderId): string | undefined {
  return searchProviderEnvVars[id];
}



export function envValue(provider: ProviderId): string | undefined {
  // Modal is the one provider whose credential is a *pair*: the proxy token id
  if (provider === 'modal') {
    const id = process.env.MODAL_PROXY_TOKEN_ID?.trim();
    const secret = process.env.MODAL_PROXY_TOKEN_SECRET?.trim();
    return id && secret ? `${id}:${secret}` : undefined;
  }
  const envVar = getEnvVar(provider);
  if (!envVar) {
    return undefined;
  }
  const value = process.env[envVar];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve all API keys for a provider.
 *
 * Precedence:
 *   1. Stored multi/single key under `llm:<provider>` (keychain / fallback)
 *   2. Env var as a single synthetic slot when nothing is stored
 *
 * `ollama` returns the host URL as a single local "key" for listing only.
 */
export async function getProviderKeys(provider: ProviderId): Promise<ProviderKeysResult> {
  if (provider === 'ollama') {
    const local = envValue(provider) ?? getConfig().ollamaHost;
    if (!local) return { keys: [], activeIndex: 0, source: 'missing' };
    return {
      keys: [{ id: 'ollama-host', value: local, createdAt: 0 }],
      activeIndex: 0,
      source: 'local',
    };
  }

  const stored = await getSecret('llm', provider);
  if (stored.value) {
    const parsed = parseProviderKeysPayload(stored.value);
    return {
      keys: parsed.keys,
      activeIndex: parsed.activeIndex,
      source: stored.source,
    };
  }

  const env = envValue(provider);
  if (env) {
    return {
      keys: [{ id: 'env', value: env, createdAt: 0 }],
      activeIndex: 0,
      source: 'env',
    };
  }

  if (provider === 'free') {
    return {
      keys: [{ id: 'keyless', value: '', createdAt: 0 }],
      activeIndex: 0,
      source: 'local',
    };
  }

  return { keys: [], activeIndex: 0, source: 'missing' };
}

/**
 * Resolve an LLM provider's secret using the precedence:
 *
 *   1. OS keychain account `llm:<provider>` (with lazy migration of the
 *      legacy bare `<provider>` account) — i.e. a key the user explicitly
 *      stored via `clai set <provider> <key>` always wins.
 *   2. Restricted-permission plaintext fallback file (`~/.clai/keys.json`)
 *   3. Provider env var (e.g. `OPENAI_API_KEY`) — used only when nothing has
 *      been explicitly stored, so a stale ambient export can never override
 *      a key the user deliberately set with `clai set`.
 *
 * Returns the **active** (sticky) key when multiple are configured.
 *
 * `ollama` is special-cased: it has no API key, only a base URL drawn from
 * `OLLAMA_HOST` or the user-config `ollamaHost`.
 */
export async function getProviderSecret(provider: ProviderId): Promise<{ value?: string; source: ProviderStatus['source'] }> {
  const multi = await getProviderKeys(provider);
  if (multi.keys.length === 0) {
    return { source: 'missing' };
  }
  const start = clampActiveIndex(multi.activeIndex, multi.keys.length);
  for (let offset = 0; offset < multi.keys.length; offset += 1) {
    const slot = multi.keys[(start + offset) % multi.keys.length]!;
    if (!slot.disabled) return { value: slot.value, source: multi.source };
  }
  return { source: multi.source };
}

export async function setProviderKeys(
  provider: ProviderId,
  values: readonly string[],
  activeIndex = 0,
  disabledValues?: readonly string[],
): Promise<'keychain' | 'fallback'> {
  if (provider === 'ollama') {
    return 'fallback';
  }
  const cleaned = values.map((v) => v.trim()).filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const v of cleaned) {
    if (seen.has(v)) continue;
    seen.add(v);
    unique.push(v);
    if (unique.length >= MAX_PROVIDER_KEYS) break;
  }
  if (unique.length === 0) {
    await unsetSecret('llm', provider);
    return 'fallback';
  }
  let carried = disabledValues;
  if (carried === undefined) {
    const stored = await getSecret('llm', provider);
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
  const payload = serializeProviderKeysPayload(slots, activeIndex);
  return setSecret('llm', provider, payload);
}

export async function appendProviderKey(
  provider: ProviderId,
  secret: string,
): Promise<'keychain' | 'fallback'> {
  if (provider === 'ollama') {
    return 'fallback';
  }
  const trimmed = secret.trim();
  if (!trimmed) {
    throw new Error('empty API key');
  }
  const current = await getProviderKeys(provider);
  const base =
    current.source === 'env'
      ? []
      : current.keys.map((k) => ({ ...k }));
  if (base.some((k) => k.value === trimmed)) {
    const idx = base.findIndex((k) => k.value === trimmed);
    const payload = serializeProviderKeysPayload(base, idx >= 0 ? idx : current.activeIndex);
    return setSecret('llm', provider, payload);
  }
  if (base.length >= MAX_PROVIDER_KEYS) {
    throw new Error(`at most ${MAX_PROVIDER_KEYS} API keys per provider`);
  }
  base.push({ id: newKeyId(), value: trimmed, createdAt: Date.now() });
  const payload = serializeProviderKeysPayload(
    base,
    base.length === 1 ? 0 : current.activeIndex,
  );
  return setSecret('llm', provider, payload);
}

export async function setProviderSecret(provider: ProviderId, secret: string): Promise<'keychain' | 'fallback'> {
  return appendProviderKey(provider, secret);
}

export async function unsetProviderSecret(provider: ProviderId): Promise<void> {
  await unsetSecret('llm', provider);
}

export async function markProviderKeySuccess(
  provider: ProviderId,
  index: number,
): Promise<void> {
  if (provider === 'ollama') return;
  const stored = await getSecret('llm', provider);
  if (!stored.value) return;
  const parsed = parseProviderKeysPayload(stored.value);
  if (parsed.keys.length === 0) return;
  const next = clampActiveIndex(index, parsed.keys.length);
  if (next === parsed.activeIndex && stored.value.trim().startsWith('{')) {
    return;
  }
  const payload = serializeProviderKeysPayload(parsed.keys, next);
  await setSecret('llm', provider, payload);
}

export async function setProviderKeyDisabled(
  provider: ProviderId,
  value: string,
  disabled: boolean,
): Promise<boolean> {
  const stored = await getSecret('llm', provider);
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
  await setSecret('llm', provider, serializeProviderKeysPayload(keys, parsed.activeIndex));
  return true;
}

export { MAX_PROVIDER_KEYS };

export type KeychainStatus =
  | { available: true }
  | { available: false; reason: 'module-missing' | 'runtime-error'; detail?: string };

/**
 * Probes the OS keychain by performing a harmless read against a marker
 * service. Used by `clai doctor` so users can tell at a glance whether
 * secrets land in the OS store or the restricted-permission plaintext
 * fallback file at ~/.clai/keys.json.
 */
export async function probeKeychain(): Promise<KeychainStatus> {
  const keytar = await loadKeytar();
  if (!keytar) return { available: false, reason: 'module-missing' };
  try {
    await keytar.getPassword(serviceName, '__clai_probe__');
    return { available: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isMissingKeychainError(error)) setKeychainRuntimeUnavailable(true);
    return { available: false, reason: 'runtime-error', detail: message };
  }
}

function endpointNote(provider: ProviderId): string | undefined {
  const { urls, activeIndex, disabledUrls } = getProviderEndpoints(provider);
  const active = getActiveProviderEndpoint(provider);
  if (urls.length === 0) {
    if (active) return `${active} (env)`;
    return provider === 'modal'
      ? 'no endpoint URL — clai set modal --url <endpoint>'
      : 'default gateway';
  }
  const disabledCount = (disabledUrls ?? []).length;
  const disabledTag = disabledCount > 0 ? ` · ${disabledCount} disabled` : '';
  if (!active) {
    return `${urls.length} endpoint${urls.length === 1 ? '' : 's'} · all disabled`;
  }
  const activePos = urls.indexOf(active);
  const suffix =
    activePos < 0
      ? ` · env override ${active}`
      : activePos !== activeIndex
        ? ` · using ${active}`
        : '';
  if (urls.length === 1) return `${urls[0]}${suffix}${disabledTag}`;
  const shown = activePos >= 0 ? activePos : activeIndex;
  return `${urls.length} endpoints · active #${shown + 1} ${urls[shown]}${suffix}${disabledTag}`;
}

export async function listProviderStatuses(activeProvider: ProviderId): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = [];
  const { getCustomProviders } = await import('./config.js');
  const customIds = getCustomProviders().map((d) => d.id as ProviderId);
  const allIds: ProviderId[] = [...providerIds, ...customIds];
  for (const provider of allIds) {
    const multi = await getProviderKeys(provider);
    const keyless = provider === 'ollama' || provider === 'free';
    const configured = multi.keys.length > 0 || provider === 'ollama';
    const activeIdx = clampActiveIndex(multi.activeIndex, multi.keys.length);
    const activeValue = multi.keys[activeIdx]?.value;
    const maskedKeys =
      !keyless && multi.keys.length > 0
        ? multi.keys.map((k) => maskSecret(k.value))
        : undefined;
    const endpointInfo = providerUsesEndpoints(provider)
      ? getProviderEndpoints(provider)
      : undefined;
    statuses.push({
      provider,
      label: provider,
      active: provider === activeProvider,
      configured,
      source: multi.keys.length > 0 ? multi.source : 'missing',
      maskedKey:
        activeValue && !keyless ? maskSecret(activeValue) : undefined,
      keyCount: keyless ? undefined : multi.keys.length || undefined,
      maskedKeys,
      activeMaskedKey:
        activeValue && !keyless && multi.keys.length > 1
          ? maskSecret(activeValue)
          : undefined,
      keyDisabled:
        !keyless && multi.keys.length > 0
          ? multi.keys.map((k) => k.disabled === true)
          : undefined,
      model: getDefaultModel(provider),
      note:
        provider === 'ollama'
          ? activeValue
          : provider === 'free'
            ? 'keyless · no API key needed'
            : providerUsesEndpoints(provider)
              ? endpointNote(provider)
              : undefined,
      endpoints: endpointInfo?.urls,
      activeEndpointIndex: endpointInfo?.activeIndex,
      disabledEndpoints:
        endpointInfo?.disabledUrls && endpointInfo.disabledUrls.length > 0
          ? endpointInfo.disabledUrls
          : undefined,
    });
  }
  return statuses;
}

export { maskSecret };
