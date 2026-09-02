import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import type { ProviderStatus } from "../../types.js";
import { getConfig } from "../config.js";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const serviceName = 'clai';

// missing on a platform — falling back to a *restricted-permission plaintext*
// is NOT encrypted; it is plaintext that the OS protects with file permissions.
const keychainModuleName = '@napi-rs/keyring/keytar.js';

export const keysFile = join(homedir(), '.clai', 'keys.json');

type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

export type SecretNamespace = 'llm' | 'search';

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

// (libsecret/DBus on Linux, Windows Credential Manager) is unreachable.
// to the restricted-permission plaintext JSON file silently.
export let keychainRuntimeUnavailable = false;

let keychainRuntimeWarned = false;

export async function loadKeytar(): Promise<KeytarLike | undefined> {
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

export function isMissingKeychainError(error: unknown): boolean {
  // Best-effort detection so transient errors (eg locked keychain prompt
  // dismissed) don't permanently disable the keychain. Anything that
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

/**
 * Compose the keychain account name used for a `(namespace, id)` pair.
 * Exposed so tests and callers can inspect the exact account string.
 */
export function secretAccount(namespace: SecretNamespace, id: string): string {
  return `${namespace}:${id}`;
}

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
    // touching the OS keychain. Writing to the keychain on every read
    // process is not in the keychain item's access-control list), which
    // of truth; the keychain is written only when a key is explicitly
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
  // the OS keychain is an opportunistic layer on top.
  const fallback = await readFallback();
  fallback[account] = value;
  if (namespace === 'llm') delete fallback[id];
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

export function setKeychainRuntimeUnavailable(value: boolean): void {
  keychainRuntimeUnavailable = value;
}
