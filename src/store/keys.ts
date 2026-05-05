import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { ProviderId, ProviderStatus } from '../types.js';
import { providerIds } from '../types.js';
import { envVars, getDefaultModel, maskSecret } from '../llm/provider.js';
import { getConfig } from './config.js';

const serviceName = 'clai';
const keychainModuleName = 'keytar';
const keysFile = join(homedir(), '.clai', 'keys.json');

type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

type FallbackKeys = Partial<Record<ProviderId, string>>;

async function loadKeytar(): Promise<KeytarLike | undefined> {
  try {
    const imported = (await import(keychainModuleName)) as { default?: KeytarLike } & KeytarLike;
    return imported.default ?? imported;
  } catch {
    return undefined;
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

  const keytar = await loadKeytar();
  if (keytar) {
    const fromKeychain = await keytar.getPassword(serviceName, provider);
    if (fromKeychain) {
      return { value: fromKeychain, source: 'keychain' };
    }
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

  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.setPassword(serviceName, provider, secret);
    return 'keychain';
  }

  const fallback = await readFallback();
  fallback[provider] = secret;
  await writeFallback(fallback);
  return 'fallback';
}

export async function unsetProviderSecret(provider: ProviderId): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(serviceName, provider);
  }

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
