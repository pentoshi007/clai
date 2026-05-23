import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId, ProviderStatus } from '../types.js';
import { providerIds } from '../types.js';
import { envVars, getDefaultModel, maskSecret } from '../llm/provider.js';
import { getConfig } from './config.js';

const serviceName = 'clai';
// `@napi-rs/keyring` ships prebuilt napi binaries (no node-gyp / prebuild-install)
// and exposes a keytar-compatible API at the `/keytar` subpath. We dynamically
// import it so the CLI keeps working when the optional native binding is
// missing on a platform — falling back to the encrypted JSON keys file.
const keychainModuleName = '@napi-rs/keyring/keytar.js';
const keysFile = join(homedir(), '.clai', 'keys.json');

type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

type FallbackKeys = Partial<Record<ProviderId, string>>;

let cachedKeytar: KeytarLike | undefined;
let keytarLoadAttempted = false;
// On many Linux servers and most Windows non-interactive sessions the
// napi-rs keyring binary loads cleanly but the underlying OS keystore
// (libsecret/DBus on Linux, Windows Credential Manager) is unreachable.
// In that case the first call fails — we record it and stop trying
// for the rest of the process so every read/write/delete falls back
// to the encrypted JSON file silently.
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
      `clai: OS keychain unavailable (${message.split('\n')[0]}); using encrypted file at ${keysFile}\n`,
    );
  }
}

async function withKeytar<T>(
  fn: (keytar: KeytarLike) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (keychainRuntimeUnavailable) return { ok: false };
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
  const raw = await readFile(keysFile, 'utf8');
  return JSON.parse(raw) as FallbackKeys;
}

async function writeFallback(keys: FallbackKeys): Promise<void> {
  await mkdir(dirname(keysFile), { recursive: true });
  await writeFile(keysFile, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(keysFile, 0o600);
  }
}

export function getFallbackKeysPath(): string {
  return keysFile;
}

export function envValue(provider: ProviderId): string | undefined {
  const envVar = envVars[provider];
  if (!envVar) {
    return undefined;
  }
  const value = process.env[envVar];
  return value && value.length > 0 ? value : undefined;
}

export async function getProviderSecret(provider: ProviderId): Promise<{ value?: string; source: ProviderStatus['source'] }> {
  const env = envValue(provider);
  if (env) {
    return { value: env, source: provider === 'ollama' ? 'local' : 'env' };
  }

  if (provider === 'ollama') {
    return { value: getConfig().ollamaHost, source: 'local' };
  }

  const keychainResult = await withKeytar((keytar) =>
    keytar.getPassword(serviceName, provider),
  );
  if (keychainResult.ok && keychainResult.value) {
    return { value: keychainResult.value, source: 'keychain' };
  }

  const fallback = await readFallback();
  const fromFallback = fallback[provider];
  if (fromFallback) {
    return { value: fromFallback, source: 'fallback' };
  }

  return { source: 'missing' };
}

export async function setProviderSecret(provider: ProviderId, secret: string): Promise<'keychain' | 'fallback'> {
  if (provider === 'ollama') {
    return 'fallback';
  }

  const keychainResult = await withKeytar((keytar) =>
    keytar.setPassword(serviceName, provider, secret),
  );
  if (keychainResult.ok) return 'keychain';

  const fallback = await readFallback();
  fallback[provider] = secret;
  await writeFallback(fallback);
  return 'fallback';
}

export async function unsetProviderSecret(provider: ProviderId): Promise<void> {
  // Best-effort: try the keychain first, but never fail the whole call
  // if it errors. The fallback-file cleanup below always runs.
  await withKeytar((keytar) => keytar.deletePassword(serviceName, provider));

  if (existsSync(keysFile)) {
    const fallback = await readFallback();
    delete fallback[provider];
    if (Object.keys(fallback).length === 0) {
      await rm(keysFile, { force: true });
    } else {
      await writeFallback(fallback);
    }
  }
}

export type KeychainStatus =
  | { available: true }
  | { available: false; reason: 'module-missing' | 'runtime-error'; detail?: string };

/**
 * Probes the OS keychain by performing a harmless read against a marker
 * service. Used by `clai doctor` so users can tell at a glance whether
 * secrets land in the OS store or the encrypted JSON fallback.
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
