import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fixOwner, handlePermissionError, safeExists } from "../../os/permissions.js";
import { getDataDir } from "../../store/paths.js";
import type { OAuthTokenSet, OAuthTokenStore } from "./types.js";

const SERVICE = "clai";
const ACCOUNT_PREFIX = "mcp-oauth:";
const KEYCHAIN_MODULE = "@napi-rs/keyring/keytar.js";

type KeytarLike = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

type FallbackFile = Record<string, string>;

let cachedKeytar: KeytarLike | undefined;
let keytarAttempted = false;
let keychainRuntimeDown = false;

function tokensFilePath(): string {
  return join(getDataDir(), "mcp-oauth.json");
}

export function oauthTokenKey(resource: string, issuer: string): string {
  return `${resource}|${issuer}`;
}

function accountFor(key: string): string {
  return `${ACCOUNT_PREFIX}${key}`;
}

function isCompiledLinuxBinary(): boolean {
  if (process.platform !== "linux") return false;
  if (typeof process.versions.bun !== "string") return false;
  return basename(process.execPath).toLowerCase() !== "bun";
}

function keychainDisabled(): boolean {
  if (keychainRuntimeDown) return true;
  if (process.env.CLAI_DISABLE_KEYCHAIN === "1") return true;
  if (isCompiledLinuxBinary() && process.env.CLAI_ENABLE_KEYCHAIN !== "1") return true;
  return false;
}

async function loadKeytar(): Promise<KeytarLike | undefined> {
  if (cachedKeytar) return cachedKeytar;
  if (keytarAttempted) return cachedKeytar;
  keytarAttempted = true;
  try {
    const imported = (await import(KEYCHAIN_MODULE)) as { default?: KeytarLike } & KeytarLike;
    cachedKeytar = imported.default ?? imported;
    return cachedKeytar;
  } catch {
    return undefined;
  }
}

async function withKeytar<T>(
  fn: (keytar: KeytarLike) => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (keychainDisabled()) return { ok: false };
  const keytar = await loadKeytar();
  if (!keytar) return { ok: false };
  try {
    return { ok: true, value: await fn(keytar) };
  } catch {
    keychainRuntimeDown = true;
    return { ok: false };
  }
}

async function readFallback(): Promise<FallbackFile> {
  const file = tokensFilePath();
  if (!(await safeExists(file))) return {};
  try {
    return JSON.parse(await readFile(file, "utf8")) as FallbackFile;
  } catch {
    return {};
  }
}

async function writeFallback(data: FallbackFile): Promise<void> {
  const file = tokensFilePath();
  try {
    const dir = dirname(file);
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const content = `${JSON.stringify(data, null, 2)}\n`;
    try {
      await writeFile(file, content, { mode: 0o600 });
    } catch (writeError: any) {
      if (writeError?.code !== "EACCES" && writeError?.code !== "EPERM") throw writeError;
      await rm(file, { force: true });
      await writeFile(file, content, { mode: 0o600 });
    }
    if (process.platform !== "win32") {
      await chmod(file, 0o600).catch(() => undefined);
    }
    await fixOwner(file);
  } catch (error: any) {
    handlePermissionError(error);
  }
}

function decode(raw: string | undefined): OAuthTokenSet | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as OAuthTokenSet;
    if (typeof parsed.accessToken !== "string" || parsed.accessToken.length === 0) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export const defaultOAuthTokenStore: OAuthTokenStore = {
  async load(key: string): Promise<OAuthTokenSet | undefined> {
    const account = accountFor(key);
    const fallback = await readFallback();
    const fromFile = decode(fallback[account]);
    if (fromFile) return fromFile;
    const result = await withKeytar((keytar) => keytar.getPassword(SERVICE, account));
    if (result.ok && result.value) return decode(result.value);
    return undefined;
  },
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    const account = accountFor(key);
    const serialized = JSON.stringify(tokens);
    const fallback = await readFallback();
    fallback[account] = serialized;
    await writeFallback(fallback);
    await withKeytar((keytar) => keytar.setPassword(SERVICE, account, serialized));
  },
  async remove(key: string): Promise<void> {
    const account = accountFor(key);
    await withKeytar((keytar) => keytar.deletePassword(SERVICE, account));
    if (!(await safeExists(tokensFilePath()))) return;
    const fallback = await readFallback();
    if (account in fallback) {
      delete fallback[account];
      if (Object.keys(fallback).length === 0) {
        await rm(tokensFilePath(), { force: true });
      } else {
        await writeFallback(fallback);
      }
    }
  },
  async loadForResource(resource: string): Promise<OAuthTokenSet | undefined> {
    const prefix = `${ACCOUNT_PREFIX}${resource}|`;
    const fallback = await readFallback();
    let best: OAuthTokenSet | undefined;
    for (const [account, raw] of Object.entries(fallback)) {
      if (!account.startsWith(prefix)) continue;
      const tokens = decode(raw);
      if (!tokens) continue;
      if (!best || rank(tokens) > rank(best)) best = tokens;
    }
    return best;
  },
};

function rank(tokens: OAuthTokenSet): number {
  return tokens.expiresAt ?? Number.MAX_SAFE_INTEGER;
}
