import { chmod, mkdir, readFile, rm, writeFile, chown } from 'node:fs/promises';
import { fixOwner, handlePermissionError } from '../os/permissions.js';

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId, ProviderStatus } from '../types.js';
import { providerIds } from '../types.js';
import { envVars, getDefaultModel, maskSecret } from '../llm/provider.js';
import { getConfig } from './config.js';
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
    process.stderr.write(
      `clai: OS keychain unavailable (${message.split('\n')[0]}); using restricted-permission plaintext file at ${keysFile}\n`,
    );
  }
}

async function withKeytar<T>(
  fn: (keytar: KeytarLike) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (keychainRuntimeUnavailable) return { ok: false };
  if (process.env.CLAI_DISABLE_KEYCHAIN === "1" || getConfig().disableKeychain) {
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
  if (!existsSync(keysFile)) {
    return {};
  }
  try {
    const raw = await readFile(keysFile, 'utf8');
    return JSON.parse(raw) as FallbackKeys;
  } catch (err: any) {
    handlePermissionError(err);
  }
}

async function writeFallback(keys: FallbackKeys): Promise<void> {
  try {
    const dir = dirname(keysFile);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    await writeFile(keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      await chmod(keysFile, 0o600);
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
};

export function searchProviderEnvVar(id: SearchProviderId): string | undefined {
  return searchProviderEnvVars[id];
}

// ---------------------------------------------------------------------------
// Low-level namespaced secret API
// ---------------------------------------------------------------------------

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
    // Found in fallback file. Try to migrate/save to OS keychain.
    const keychainResult = await withKeytar((keytar) =>
      keytar.setPassword(serviceName, account, fallbackValue!),
    );
    if (keychainResult.ok) {
      // Successfully migrated to keychain. Clean up from fallback.
      delete fallback[account];
      if (namespace === 'llm') {
        delete fallback[id];
        // Also cleanup bare-id from keychain if migrating to namespaced
        await withKeytar((keytar) => keytar.deletePassword(serviceName, id));
      }
      await writeFallback(fallback);
      return { value: fallbackValue, source: 'keychain' };
    }
    
    // If keychain migration failed, return fallback value.
    // First, migrate legacy key in fallback file itself.
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
      return { value: legacy.value, source: 'keychain' };
    }
  }

  return { source: 'missing' };
}

/**
 * Persist `value` for `(namespace, id)`. Tries the OS keychain first; on
 * failure (module missing, runtime error, or permission denied) writes the
 * value into the restricted-permission plaintext fallback file at
 * `~/.clai/keys.json`. Returns the chosen storage backend so callers can
 * surface the plaintext-fallback warning.
 *
 * When the keychain cannot be written but may still be readable (a common
 * failure mode on macOS/Linux when the keyring is locked or permission is
 * denied), any existing keychain entry is deleted best-effort. Otherwise a
 * stale keychain value would shadow the freshly-written fallback value and
 * `clai set` would appear to have no effect.
 */
export async function setSecret(
  namespace: SecretNamespace,
  id: string,
  value: string,
): Promise<'keychain' | 'fallback'> {
  const account = secretAccount(namespace, id);

  const keychainResult = await withKeytar((keytar) =>
    keytar.setPassword(serviceName, account, value),
  );
  if (keychainResult.ok) {
    // Best-effort cleanup of any legacy bare-id entry so the namespaced
    // account is the single source of truth going forward.
    if (namespace === 'llm') {
      await withKeytar((keytar) => keytar.deletePassword(serviceName, id));
    }
    // Also cleanup fallback file so we don't have stale secrets there shadowing/duplicating
    if (existsSync(keysFile)) {
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
        await writeFallback(fallback);
      }
    }
    return 'keychain';
  }

  const fallback = await readFallback();
  fallback[account] = value;
  if (namespace === 'llm') delete fallback[id];
  await writeFallback(fallback);

  // If we land in the plaintext fallback, make sure a pre-existing keychain
  // entry (which may still be readable) does not win over the value the user
  // just set. Ignore failures: if the keychain is truly unreachable, both
  // reads and deletes will be no-ops after the first failure is latched.
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

  if (existsSync(keysFile)) {
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

// ---------------------------------------------------------------------------
// Provider-facing helpers
// ---------------------------------------------------------------------------

export function envValue(provider: ProviderId): string | undefined {
  const envVar = envVars[provider];
  if (!envVar) {
    return undefined;
  }
  const value = process.env[envVar];
  return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve an LLM provider's secret using the precedence:
 *
 *   1. OS keychain account `llm:<provider>` (with lazy migration of the
 *      legacy bare `<provider>` account) — i.e. a key the user explicitly
 *      stored via `clai set <provider> <key>` always wins.
 *   2. Restricted-permission plaintext fallback file (`~/.clai/keys.json`)
 *   3. Provider env var (e.g. `GROQ_API_KEY`) — used only when nothing has
 *      been explicitly stored, so a stale ambient export can never override
 *      a key the user deliberately set with `clai set`.
 *
 * `ollama` is special-cased: it has no API key, only a base URL drawn from
 * `OLLAMA_HOST` or the user-config `ollamaHost`.
 */
export async function getProviderSecret(provider: ProviderId): Promise<{ value?: string; source: ProviderStatus['source'] }> {
  if (provider === 'ollama') {
    const local = envValue(provider) ?? getConfig().ollamaHost;
    return { value: local, source: 'local' };
  }

  // A key the user explicitly stored via `clai set` takes precedence over
  // an ambient env-var export. This matters in practice: a stale
  // `export OPENAI_API_KEY=...` in a shell rc file would otherwise shadow
  // a freshly-set keychain entry and surface as an opaque 401.
  const stored = await getSecret('llm', provider);
  if (stored.value) {
    return stored;
  }

  const env = envValue(provider);
  if (env) {
    return { value: env, source: 'env' };
  }

  return { source: 'missing' };
}

export async function setProviderSecret(provider: ProviderId, secret: string): Promise<'keychain' | 'fallback'> {
  if (provider === 'ollama') {
    return 'fallback';
  }
  return setSecret('llm', provider, secret);
}

export async function unsetProviderSecret(provider: ProviderId): Promise<void> {
  await unsetSecret('llm', provider);
}

/**
 * Resolve a search-provider's API key using the precedence required by
 * Requirement 3.3: env var → keychain `search:<id>` → fallback file →
 * `undefined`. DuckDuckGo has no env var and no key, so it returns
 * `{ source: 'missing' }` unless a key has been explicitly set.
 */
export async function getSearchProviderKey(
  id: SearchProviderId,
): Promise<{ value?: string; source: SecretSource }> {
  const envVar = searchProviderEnvVars[id];
  if (envVar) {
    const fromEnv = process.env[envVar];
    if (fromEnv && fromEnv.length > 0) {
      return { value: fromEnv, source: 'env' };
    }
  }
  return getSecret('search', id);
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

export async function listProviderStatuses(activeProvider: ProviderId): Promise<ProviderStatus[]> {
  const statuses: ProviderStatus[] = [];
  for (const provider of providerIds) {
    const secret = await getProviderSecret(provider);
    const configured = Boolean(secret.value) || provider === 'ollama';
    statuses.push({
      provider,
      label: provider,
      active: provider === activeProvider,
      configured,
      source: secret.value ? secret.source : 'missing',
      maskedKey: secret.value && provider !== 'ollama' ? maskSecret(secret.value) : undefined,
      model: getDefaultModel(provider),
      note: provider === 'ollama' ? secret.value : undefined,
    });
  }
  return statuses;
}

// Re-export the mask helper so search-provider listings (and any other
// consumer that already imports from `./store/keys.js`) use the same
// masking rule as `clai keys` for LLM entries (Requirement 3.6).
export { maskSecret };
