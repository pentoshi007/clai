import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { fixOwner, safeExists } from "../../os/permissions.js";
import { getDataDir } from "../../store/paths.js";
import type { OAuthTokenSet, OAuthTokenStore } from "./types.js";
import { withMcpStorageLock } from "../storage-lock.js";

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

function legacyTokensFilePath(): string {
  return join(getDataDir(), "mcp-oauth.json");
}

function tokensDirectory(): string {
  return join(getDataDir(), "mcp-oauth");
}

function tokenFilePath(key: string): string {
  return join(tokensDirectory(), `${createHash("sha256").update(key).digest("hex")}.json`);
}

interface TokenRecord {
  readonly key: string;
  readonly tokens?: OAuthTokenSet | undefined;
}

async function readTokenRecord(key: string): Promise<TokenRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(tokenFilePath(key), "utf8")) as TokenRecord;
    return parsed.key === key ? parsed : { key };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : { key };
  }
}

async function writeTokenRecord(record: TokenRecord): Promise<void> {
  const directory = tokensDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await fixOwner(directory);
  const file = tokenFilePath(record.key);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
    await fixOwner(file);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function clientSuffix(clientId: string): string {
  return `|client:${createHash("sha256").update(clientId).digest("hex")}`;
}

function unscopedKey(key: string): string {
  return key.replace(/\|client:[a-f0-9]{64}$/, "");
}

export function oauthTokenKey(resource: string, issuer: string, clientId?: string): string {
  return `${resource}|${issuer}${clientId ? clientSuffix(clientId) : ""}`;
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
    const imported = (await import(KEYCHAIN_MODULE)) as {
      default?: KeytarLike;
    } & KeytarLike;
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
  const file = legacyTokensFilePath();
  if (!(await safeExists(file))) return {};
  try {
    return JSON.parse(await readFile(file, "utf8")) as FallbackFile;
  } catch {
    return {};
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
    const current = await readTokenRecord(key);
    if (current) return decode(current.tokens ? JSON.stringify(current.tokens) : undefined);
    const account = accountFor(key);
    const fallback = await readFallback();
    const baseKey = unscopedKey(key);
    const inherited = baseKey !== key ? await readTokenRecord(baseKey) : undefined;
    const baseTokens = inherited ? inherited.tokens : decode(fallback[accountFor(baseKey)]);
    const matchingLegacy =
      baseKey !== key && baseTokens?.clientId && key.endsWith(clientSuffix(baseTokens.clientId))
        ? baseTokens
        : undefined;
    const fromFile = decode(fallback[account]) ?? matchingLegacy;
    if (fromFile) {
      return withMcpStorageLock(`store:${key}`, async () => {
        const latest = await readTokenRecord(key);
        if (latest) return decode(latest.tokens ? JSON.stringify(latest.tokens) : undefined);
        await writeTokenRecord({ key, tokens: fromFile });
        return fromFile;
      });
    }
    const result = await withKeytar((keytar) => keytar.getPassword(SERVICE, account));
    if (result.ok && result.value) return decode(result.value);
    return undefined;
  },
  async save(key: string, tokens: OAuthTokenSet): Promise<void> {
    const account = accountFor(key);
    const serialized = JSON.stringify(tokens);
    await withMcpStorageLock(`store:${key}`, () => writeTokenRecord({ key, tokens }));
    await withKeytar((keytar) => keytar.setPassword(SERVICE, account, serialized));
  },
  async remove(key: string): Promise<void> {
    const account = accountFor(key);
    await withMcpStorageLock(`store:${key}`, () => writeTokenRecord({ key }));
    await withKeytar((keytar) => keytar.deletePassword(SERVICE, account));
  },
  async loadForResource(resource: string, clientId?: string): Promise<OAuthTokenSet | undefined> {
    const prefix = `${resource}|`;
    const entries = await readdir(tokensDirectory()).catch(() => [] as string[]);
    const records = await Promise.all(
      entries
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          try {
            return JSON.parse(await readFile(join(tokensDirectory(), name), "utf8")) as TokenRecord;
          } catch {
            return undefined;
          }
        }),
    );
    const seen = new Set(
      records.flatMap((record) => (record && typeof record.key === "string" ? [record.key] : [])),
    );
    const matchesClient = (key: string, tokens: OAuthTokenSet): boolean => {
      const base = unscopedKey(key);
      if (!clientId) return key === base;
      if (tokens.clientId !== clientId) return false;
      const scoped = `${base}${clientSuffix(clientId)}`;
      return key === scoped || (key === base && !seen.has(scoped));
    };
    let best: OAuthTokenSet | undefined;
    for (const record of records) {
      if (!record || typeof record.key !== "string" || !record.key.startsWith(prefix)) continue;
      const tokens = decode(record.tokens ? JSON.stringify(record.tokens) : undefined);
      if (tokens && matchesClient(record.key, tokens) && (!best || rank(tokens) > rank(best)))
        best = { ...tokens, issuer: unscopedKey(record.key).slice(prefix.length) };
    }
    const fallback = await readFallback();
    for (const [account, raw] of Object.entries(fallback)) {
      if (!account.startsWith(`${ACCOUNT_PREFIX}${prefix}`)) continue;
      const key = account.slice(ACCOUNT_PREFIX.length);
      if (seen.has(key)) continue;
      const tokens = decode(raw);
      if (!tokens || !matchesClient(key, tokens)) continue;
      if (!best || rank(tokens) > rank(best))
        best = { ...tokens, issuer: unscopedKey(key).slice(prefix.length) };
    }
    return best;
  },
  withRefreshLock: withMcpStorageLock,
};

function rank(tokens: OAuthTokenSet): number {
  return tokens.expiresAt ?? Number.MAX_SAFE_INTEGER;
}
