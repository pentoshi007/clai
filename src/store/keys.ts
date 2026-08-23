import { chmod, mkdir, readFile, rm, writeFile, chown } from 'node:fs/promises';
import { fixOwner, handlePermissionError, safeExists } from '../os/permissions.js';

import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId, ProviderStatus } from '../types.js';
import { providerIds } from '../types.js';
import { envVars, getDefaultModel, getEnvVar, maskSecret } from '../llm/provider.js';
import {
  getActiveProviderEndpoint,
  getConfig,
  getProviderEndpoints,
  providerUsesEndpoints,
} from './config.js';
import type { SearchProviderId } from '../tools/web/types.js';

const serviceName = 'clai';
// `@napi-rs/keyring` ships prebuilt napi binaries (no node-gyp / prebuild-install)
// and exposes a keytar-compatible API at the `/keytar` subpath. We dynamically
// import it so the CLI keeps working when the optional native binding is
// missing on a platform — falling back to a *restricted-permission plaintext*
// JSON file (mode 0600) at ~/.clai/keys.json. Despite older docs, this fallback
// is NOT encrypted; it is plaintext that the OS protects with file permissions.
// The agent is also blocked from reading that path (see safety/patterns.ts).
const keychainModuleName = '@napi-rs/keyring/keytar.js';
const keysFile = join(homedir(), '.clai', 'keys.json');

type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

/**
 * Logical namespace for a stored secret. Search-provider keys live in the
 * same keyring service as LLM keys but under separate accounts so the two
 * keyspaces never collide.
 */
export type SecretNamespace = 'llm' | 'search';

/** Where a resolved secret value originated. Mirrors `ProviderStatus.source`. */
export type SecretSource = ProviderStatus['source'];

/**
 * On-disk shape of the restricted-permission plaintext fallback file.
 * Keys are either namespaced (`<namespace>:<id>`) or, for backwards
 * compatibility, the bare LLM `ProviderId` written by older clai versions.
 * Bare entries are migrated lazily into the `llm:` namespace on read.
 */
type FallbackKeys = Record<string, string>;

let cachedKeytar: KeytarLike | undefined;
let keytarLoadAttempted = false;
// On many Linux servers and most Windows non-interactive sessions the
// napi-rs keyring binary loads cleanly but the underlying OS keystore
// (libsecret/DBus on Linux, Windows Credential Manager) is unreachable.
// In that case the first call fails — we record it and stop trying
// for the rest of the process so every read/write/delete falls back
// to the restricted-permission plaintext JSON file silently.
let keychainRuntimeUnavailable = false;
let keychainRuntimeWarned = false;

async function loadKeytar(): Promise<KeytarLike | undefined> {
  if (cachedKeytar) return cachedKeytar;
  if (keytarLoadAttempted) return cachedKeytar;
  keytarLoadAttempted = true;
  try {
    const imported = (await import(keychainModuleName)) as { default?: KeytarLike } & KeytarLike;
    cachedKeytar = imported.default ?? imported;
    return cachedKeytar;
  } catch {
    return undefined;
  }
}

function isMissingKeychainError(error: unknown): boolean {
  // Best-effort detection so transient errors (eg locked keychain prompt
  // dismissed) don't permanently disable the keychain. Anything that
  // looks like a missing-platform-service signature gets latched off.
  const message = error instanceof Error ? error.message : String(error);
  return /(no such (?:bus|service)|secret service|libsecret|dbus|keyring|gnome-keyring|kwallet|credential|keychain|security framework|access denied|not (?:available|implemented))/i.test(
    message,
  );
}

function noteKeychainRuntimeFailure(error: unknown): void {
  if (isMissingKeychainError(error)) keychainRuntimeUnavailable = true;
  if (!keychainRuntimeWarned) {
    keychainRuntimeWarned = true;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `clai: OS keychain unavailable (${message.split('\n')[0]}); using restricted-permission plaintext file at ${keysFile}`,
    );
  }
}

function isCompiledLinuxBinary(): boolean {
  if (process.platform !== 'linux') return false;
  if (typeof process.versions.bun !== 'string') return false;
  return basename(process.execPath).toLowerCase() !== 'bun';
}

async function withKeytar<T>(
  fn: (keytar: KeytarLike) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (keychainRuntimeUnavailable) return { ok: false };
  if (process.env.CLAI_DISABLE_KEYCHAIN === "1" || getConfig().disableKeychain) {
    return { ok: false };
  }
  if (isCompiledLinuxBinary() && process.env.CLAI_ENABLE_KEYCHAIN !== "1") {
    return { ok: false };
  }
  const keytar = await loadKeytar();
  if (!keytar) return { ok: false };
  try {
    return { ok: true, value: await fn(keytar) };
  } catch (error) {
    noteKeychainRuntimeFailure(error);
    return { ok: false };
  }
}

async function readFallback(): Promise<FallbackKeys> {
  if (!(await safeExists(keysFile))) {
    return {};
  }
  try {
    const raw = await readFile(keysFile, 'utf8');
    return JSON.parse(raw) as FallbackKeys;
  } catch {
    return {};
  }
}


async function writeFallback(keys: FallbackKeys): Promise<void> {
  try {
    const dir = dirname(keysFile);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const content = `${JSON.stringify(keys, null, 2)}\n`;
    try {
      await writeFile(keysFile, content, { mode: 0o600 });
    } catch (writeError: any) {
      if (writeError?.code !== 'EACCES' && writeError?.code !== 'EPERM') throw writeError;
      await rm(keysFile, { force: true });
      await writeFile(keysFile, content, { mode: 0o600 });
    }
    if (process.platform !== 'win32') {
      try {
        await chmod(keysFile, 0o600);
      } catch {
        try {
          await rm(keysFile, { force: true });
          await writeFile(keysFile, content, { mode: 0o600 });
        } catch {
        }
      }
    }
    await fixOwner(keysFile);
  } catch (err: any) {
    handlePermissionError(err);
  }
}

export function getFallbackKeysPath(): string {
  return keysFile;
}

/**
 * Compose the keychain account name used for a `(namespace, id)` pair.
 * Exposed so tests and callers can inspect the exact account string.
 */
export function secretAccount(namespace: SecretNamespace, id: string): string {
  return `${namespace}:${id}`;
}

/**
 * Env-var name used for a search provider's API key, per Requirement 3.3.
 * Returns `undefined` for keyless providers (DuckDuckGo).
 */
const searchProviderEnvVars: Record<SearchProviderId, string | undefined> = {
  brave: 'BRAVE_SEARCH_API_KEY',
  tavily: 'TAVILY_API_KEY',
  duckduckgo: undefined,
  exa: 'EXA_API_KEY',
};

export function searchProviderEnvVar(id: SearchProviderId): string | undefined {
  return searchProviderEnvVars[id];
}

// Low-level namespaced secret API

/**
 * Read a secret out of the OS keychain (preferred) or the restricted-permission
 * plaintext fallback file. Returns `{ source: 'missing' }` when neither
 * backend has a value.
 *
 * Legacy LLM entries that still live under the bare `<provider>` account
 * name (no namespace prefix) are migrated lazily into `llm:<provider>` on
 * first read so older installs keep working without manual intervention.
 */
export async function getSecret(
  namespace: SecretNamespace,
  id: string,
): Promise<{ value?: string; source: SecretSource }> {
  const account = secretAccount(namespace, id);

  // 1. Fallback file check first (ensures newer keys override keychain desync)
  const fallback = await readFallback();
  let fallbackValue = fallback[account];
  let isLegacyFallback = false;

  if (!fallbackValue && namespace === 'llm') {
    fallbackValue = fallback[id];
    if (fallbackValue) {
      isLegacyFallback = true;
    }
  }

  if (fallbackValue) {
    // Found in the durable fallback file — return it directly WITHOUT
    // touching the OS keychain. Writing to the keychain on every read
    // triggers a native authorization prompt on macOS (the calling
    // process is not in the keychain item's access-control list), which
    // made every LLM request AND every `/keys` listing re-prompt the
    // user for a password — even after clicking "Always Allow", because
    // each write re-asked. The fallback file (mode 0600) is the source
    // of truth; the keychain is written only when a key is explicitly
    // set via setSecret, never on read.
    //
    // Migrate legacy bare-id key to namespaced format in fallback file.
    if (isLegacyFallback) {
      delete fallback[id];
      fallback[account] = fallbackValue;
      await writeFallback(fallback);
    }
    return { value: fallbackValue, source: 'fallback' };
  }

  // 2. Keychain — primary store.
  const keychainResult = await withKeytar((keytar) =>
    keytar.getPassword(serviceName, account),
  );
  if (keychainResult.ok && keychainResult.value) {
    // Heal: older versions drained keys.json into the keychain. Write the
    // key back to the fallback file so it survives keychain backend changes.
    const fb = await readFallback();
    if (!(account in fb)) {
      fb[account] = keychainResult.value;
      await writeFallback(fb);
    }
    return { value: keychainResult.value, source: 'keychain' };
  }

  // Lazy migration of pre-namespaced LLM entries. Older clai versions
  // wrote `setPassword(serviceName, providerId, ...)` with no `llm:`
  // prefix; pick those up once and copy them into the new account name.
  if (namespace === 'llm') {
    const legacy = await withKeytar((keytar) =>
      keytar.getPassword(serviceName, id),
    );
    if (legacy.ok && legacy.value) {
      const migrated = await withKeytar((keytar) =>
        keytar.setPassword(serviceName, account, legacy.value as string),
      );
      if (migrated.ok) {
        await withKeytar((keytar) =>
          keytar.deletePassword(serviceName, id),
        );
      }
      // Heal: write the discovered key back to the fallback file.
      const fb = await readFallback();
      if (!(account in fb)) {
        fb[account] = legacy.value;
        await writeFallback(fb);
      }
      return { value: legacy.value, source: 'keychain' };
    }
  }

  return { source: 'missing' };
}

export async function setSecret(
  namespace: SecretNamespace,
  id: string,
  value: string,
): Promise<'keychain' | 'fallback'> {
  const account = secretAccount(namespace, id);

  // Always write to the plaintext fallback file so keys survive keychain
  // backend changes (e.g. switching from npm/Node to brew/Bun, or moving
  // between machines). The fallback file (mode 0600) is the durable store;
  // the OS keychain is an opportunistic layer on top.
  const fallback = await readFallback();
  fallback[account] = value;
  if (namespace === 'llm') delete fallback[id]; // clean up legacy bare-id
  await writeFallback(fallback);

  // Also write to OS keychain if available (best-effort).
  const keychainResult = await withKeytar((keytar) =>
    keytar.setPassword(serviceName, account, value),
  );
  if (keychainResult.ok) {
    if (namespace === 'llm') {
      // Cleanup legacy bare-id entry from keychain.
      await withKeytar((keytar) => keytar.deletePassword(serviceName, id));
    }
    return 'keychain';
  }

  // If we land in the plaintext fallback only, make sure a pre-existing
  // keychain entry (which may still be readable) does not shadow the
  // value the user just set.
  await withKeytar((keytar) => keytar.deletePassword(serviceName, account));
  if (namespace === 'llm') {
    await withKeytar((keytar) => keytar.deletePassword(serviceName, id));
  }

  return 'fallback';
}

/**
 * Best-effort delete: removes the secret from both the keychain and the
 * fallback file. Never throws on keychain errors so unset always cleans
 * up the on-disk fallback even when the OS keystore is unreachable.
 */
export async function unsetSecret(
  namespace: SecretNamespace,
  id: string,
): Promise<void> {
  const account = secretAccount(namespace, id);

  await withKeytar((keytar) => keytar.deletePassword(serviceName, account));
  if (namespace === 'llm') {
    // Sweep the legacy bare-id entry too so partially migrated installs
    // get a clean unset.
    await withKeytar((keytar) => keytar.deletePassword(serviceName, id));
  }

  if (await safeExists(keysFile)) {
    const fallback = await readFallback();
    let mutated = false;
    if (account in fallback) {
      delete fallback[account];
      mutated = true;
    }
    if (namespace === 'llm' && id in fallback) {
      delete fallback[id];
      mutated = true;
    }
    if (mutated) {
      if (Object.keys(fallback).length === 0) {
        await rm(keysFile, { force: true });
      } else {
        await writeFallback(fallback);
      }
    }
  }
}

// Provider-facing helpers (multi-key envelope)

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

const MAX_PROVIDER_KEYS = 10;

function newKeyId(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function clampActiveIndex(index: number, len: number): number {
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

export function envValue(provider: ProviderId): string | undefined {
  // Modal is the one provider whose credential is a *pair*: the proxy token id
  // and secret travel as separate headers. They are stored (and surfaced here)
  // as one `id:secret` string so key storage, masking and rotation stay
  // single-secret everywhere else. A half-set environment counts as unset.
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

/**
 * Replace the full key list for a provider (Keys editor Save).
 * Empty list clears storage (same as unset).
 */
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
  // Dedupe exact values while preserving order.
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

/**
 * Append one API key (CLI `/set provider key`). Dedupes exact matches.
 * Creates a multi-key envelope, migrating a legacy single string if needed.
 */
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
  // Env-only is not "stored" — writing creates stored keys and overrides env.
  const base =
    current.source === 'env'
      ? []
      : current.keys.map((k) => ({ ...k }));
  if (base.some((k) => k.value === trimmed)) {
    // Already present — keep list, optionally move active to that index.
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

/**
 * Compat: append a key (multi-key era). Prefer `appendProviderKey` or
 * `setProviderKeys` at new call sites.
 */
export async function setProviderSecret(provider: ProviderId, secret: string): Promise<'keychain' | 'fallback'> {
  return appendProviderKey(provider, secret);
}

export async function unsetProviderSecret(provider: ProviderId): Promise<void> {
  await unsetSecret('llm', provider);
}

/**
 * Remember which key last succeeded so the next request starts there.
 * No-op for env-only / ollama / missing storage.
 */
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
    // Already sticky on this index and in envelope form.
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
    if (isMissingKeychainError(error)) keychainRuntimeUnavailable = true;
    return { available: false, reason: 'runtime-error', detail: message };
  }
}

/**
 * One-line endpoint summary for providers with a user-supplied base URL.
 * Modal has no default, so a missing URL is a problem worth naming; Lightning
 * falls back to its shared gateway.
 */
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
  // Custom (user-defined) provider ids are appended after the built-ins so
  // `/keys` and the `/provider` picker show them alongside the built-ins.
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

// Re-export the mask helper so search-provider listings (and any other
// consumer that already imports from `./store/keys.js`) use the same
// masking rule as `clai keys` for LLM entries (Requirement 3.6).
export { maskSecret };
