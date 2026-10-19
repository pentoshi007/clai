import { createHash, webcrypto } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { FREEBUFF_API_BASE_URL } from "./freebuff-auth.js";

export const FREEBUFF_DEVICE_KEY_PATH = "/api/v1/freebuff/device-keys";
export const FREEBUFF_DEVICE_KEY_HEADER = "x-freebuff-device-key";
export const FREEBUFF_DEVICE_TS_HEADER = "x-freebuff-device-ts";
export const FREEBUFF_DEVICE_SIG_HEADER = "x-freebuff-device-sig";
export const FREEBUFF_DEVICE_CLIENT = "cli";

const CANONICAL_PREFIX = "freebuff-device-v1";
const REGISTER_TIMEOUT_MS = 10_000;
const SIGN_WAIT_MS = 3_000;
const FAILURE_RETRY_MS = 300_000;
const UNSUPPORTED_RETRY_MS = 3_600_000;

interface DeviceKeyRecord {
  version: 1;
  publicKey: string;
  privateKey: string;
  registrations: Record<string, string>;
}

interface StoredKey {
  record: DeviceKeyRecord;
  privateKey: webcrypto.CryptoKey;
}

export interface FreebuffDeviceKeyDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly now?: (() => number) | undefined;
  readonly storePath?: string | undefined;
  readonly subtle?: typeof webcrypto.subtle | undefined;
}

export interface FreebuffDeviceSignRequest {
  readonly token: string;
  readonly accountId?: string | undefined;
  readonly method: string;
  readonly url: string;
  readonly body?: string | Uint8Array | null | undefined;
  readonly fetchId?: string | undefined;
  readonly register?: boolean | undefined;
}

export function freebuffConfigDirPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.FREEBUFF_CONFIG_DIR;
  return configured && isAbsolute(configured)
    ? configured
    : join(homedir(), ".config", "manicode");
}

export function freebuffDeviceKeyFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(freebuffConfigDirPath(env), "device-key.json");
}

let testDeps: FreebuffDeviceKeyDeps = {};
let stored: Promise<StoredKey | null> | undefined;
let unavailable = false;
let inflightKey: Promise<StoredKey | null> | undefined;
const registrations = new Map<string, Promise<string | null>>();
const retryAfter = new Map<string, number>();
let saving: Promise<void> = Promise.resolve();

export function setFreebuffDeviceKeyDeps(deps: FreebuffDeviceKeyDeps): void {
  testDeps = deps;
}

export function resetFreebuffDeviceKeyState(): void {
  stored = undefined;
  inflightKey = undefined;
  unavailable = false;
  registrations.clear();
  retryAfter.clear();
  saving = Promise.resolve();
}

function fetchImpl(): typeof fetch {
  return testDeps.fetch ?? fetch;
}

function nowMs(): number {
  return testDeps.now?.() ?? Date.now();
}

function subtle(): typeof webcrypto.subtle | null {
  if (testDeps.subtle) return testDeps.subtle;
  return webcrypto?.subtle ?? null;
}

function storePath(): string {
  return testDeps.storePath ?? freebuffDeviceKeyFilePath();
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64url");
  return new Uint8Array(buffer);
}

function sha256Hex(body: string | Uint8Array | null | undefined): string {
  return createHash("sha256").update(body ?? new Uint8Array(0)).digest("hex");
}

function validRecord(value: unknown): DeviceKeyRecord | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Partial<DeviceKeyRecord>;
  if (record.version !== 1 || typeof record.publicKey !== "string" || typeof record.privateKey !== "string") {
    return null;
  }
  const registrationsValue: Record<string, string> = {};
  if (record.registrations && typeof record.registrations === "object") {
    for (const [scope, keyId] of Object.entries(record.registrations)) {
      if (typeof keyId === "string" && keyId) registrationsValue[scope] = keyId;
    }
  }
  return { version: 1, publicKey: record.publicKey, privateKey: record.privateKey, registrations: registrationsValue };
}

async function importPrivateKey(pkcs8: string): Promise<webcrypto.CryptoKey | null> {
  const crypto = subtle();
  if (!crypto) return null;
  try {
    return await crypto.importKey("pkcs8", fromB64url(pkcs8), { name: "Ed25519" }, false, ["sign"]);
  } catch {
    return null;
  }
}

function loadStoredKey(): Promise<StoredKey | null> {
  if (stored) return stored;
  stored = (async (): Promise<StoredKey | null> => {
    const crypto = subtle();
    if (!crypto) return null;
    let raw: string;
    try {
      raw = await readFile(storePath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    const record = validRecord(parsed);
    if (!record) return null;
    const privateKey = await importPrivateKey(record.privateKey);
    return privateKey ? { record, privateKey } : null;
  })().catch(() => {
    unavailable = true;
    return null;
  });
  return stored;
}

async function generateKey(): Promise<DeviceKeyRecord | null> {
  const crypto = subtle();
  if (!crypto) return null;
  try {
    const pair = (await crypto.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as unknown as webcrypto.CryptoKeyPair;
    const publicKey = new Uint8Array(await crypto.exportKey("raw", pair.publicKey));
    const privateKey = new Uint8Array(await crypto.exportKey("pkcs8", pair.privateKey));
    return { version: 1, publicKey: b64url(publicKey), privateKey: b64url(privateKey), registrations: {} };
  } catch {
    return null;
  }
}

function ensureKey(): Promise<StoredKey | null> {
  if (inflightKey) return inflightKey;
  inflightKey = (async (): Promise<StoredKey | null> => {
    const existing = await loadStoredKey();
    if (existing || unavailable) return existing;
    const record = await generateKey();
    if (!record) return null;
    const privateKey = await importPrivateKey(record.privateKey);
    if (!privateKey) return null;
    await persist(record);
    return { record, privateKey };
  })().catch(() => null);
  return inflightKey;
}

function persist(record: DeviceKeyRecord): Promise<void> {
  const snapshot: DeviceKeyRecord = { ...record, registrations: { ...record.registrations } };
  saving = saving
    .then(async () => {
      const path = storePath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    })
    .catch(() => undefined);
  return saving;
}

async function scopeFor(request: FreebuffDeviceSignRequest): Promise<string> {
  const host = new URL(request.url).origin;
  if (request.accountId) return `${host} user:${request.accountId}`;
  return `${host} token:${sha256Hex(request.token).slice(0, 32)}`;
}

async function register(scope: string, key: StoredKey, request: FreebuffDeviceSignRequest): Promise<string | null> {
  const host = new URL(request.url).origin;
  const fail = (delayMs: number): null => {
    retryAfter.set(scope, nowMs() + delayMs);
    return null;
  };
  let response: Response;
  try {
    response = await fetchImpl()(`${host}${FREEBUFF_DEVICE_KEY_PATH}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.token}`,
        "content-type": "application/json",
        "user-agent": "Bun/1.3.14",
        accept: "*/*",
      },
      body: JSON.stringify({ publicKey: key.record.publicKey, client: FREEBUFF_DEVICE_CLIENT }),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    });
  } catch {
    return fail(FAILURE_RETRY_MS);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return fail(response.status === 404 || response.status === 405 ? UNSUPPORTED_RETRY_MS : FAILURE_RETRY_MS);
  }
  const payload = (await response.json().catch(() => null)) as { keyId?: unknown } | null;
  const keyId = typeof payload?.keyId === "string" ? payload.keyId : "";
  if (!keyId) return fail(FAILURE_RETRY_MS);
  key.record.registrations[scope] = keyId;
  await persist(key.record);
  return keyId;
}

function keyIdFor(scope: string, key: StoredKey, request: FreebuffDeviceSignRequest): Promise<string | null> {
  const existing = key.record.registrations[scope];
  if (existing) return Promise.resolve(existing);
  if ((retryAfter.get(scope) ?? 0) > nowMs()) return Promise.resolve(null);
  const inflight = registrations.get(scope);
  if (inflight) return inflight;
  const attempt = register(scope, key, request).finally(() => registrations.delete(scope));
  registrations.set(scope, attempt);
  return attempt;
}

async function withinTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function prepare(request: FreebuffDeviceSignRequest, registerKey: boolean): Promise<{ keyId: string; key: StoredKey } | null> {
  const key = registerKey ? await ensureKey() : await loadStoredKey();
  if (!key) return null;
  const scope = await scopeFor(request);
  const keyId = registerKey ? await keyIdFor(scope, key, request) : key.record.registrations[scope] ?? null;
  return keyId ? { key, keyId } : null;
}

export async function freebuffDeviceSignature(
  input: {
    readonly method: string;
    readonly url: string;
    readonly body?: string | Uint8Array | null | undefined;
    readonly fetchId?: string | undefined;
    readonly timestampMs: number;
    readonly privateKey: webcrypto.CryptoKey;
    readonly subtle?: typeof webcrypto.subtle | undefined;
  },
): Promise<string> {
  const crypto = input.subtle ?? subtle();
  if (!crypto) throw new Error("Ed25519 unavailable");
  const canonical = [
    CANONICAL_PREFIX,
    input.method.toUpperCase(),
    new URL(input.url).pathname,
    String(input.timestampMs),
    sha256Hex(input.body),
    input.fetchId ?? "",
  ].join("\n");
  const signature = new Uint8Array(await crypto.sign({ name: "Ed25519" }, input.privateKey, new TextEncoder().encode(canonical)));
  return b64url(signature);
}

export async function freebuffDeviceHeaders(request: FreebuffDeviceSignRequest): Promise<Record<string, string>> {
  try {
    const deadline = nowMs() + SIGN_WAIT_MS;
    let prepared = await withinTimeout(prepare(request, request.register ?? true), Math.max(0, deadline - nowMs()));
    if (!prepared && request.register !== false) {
      prepared = await withinTimeout(prepare(request, true), Math.max(0, deadline - nowMs()));
    }
    if (!prepared) return {};
    const timestampMs = nowMs();
    const signature = await freebuffDeviceSignature({
      method: request.method,
      url: request.url,
      body: request.body ?? null,
      ...(request.fetchId !== undefined ? { fetchId: request.fetchId } : {}),
      timestampMs,
      privateKey: prepared.key.privateKey,
    });
    return {
      [FREEBUFF_DEVICE_KEY_HEADER]: prepared.keyId,
      [FREEBUFF_DEVICE_TS_HEADER]: String(timestampMs),
      [FREEBUFF_DEVICE_SIG_HEADER]: signature,
    };
  } catch {
    return {};
  }
}

export async function freebuffDevicePublicKey(): Promise<string | null> {
  const key = await loadStoredKey();
  if (key) return key.record.publicKey;
  const ensured = await ensureKey();
  return ensured?.record.publicKey ?? null;
}

export function freebuffDeviceApiBase(env: NodeJS.ProcessEnv = process.env): string {
  return env.FREEBUFF_API_BASE_URL ?? FREEBUFF_API_BASE_URL;
}

const DEVICE_KEY_ERROR = /device[_-]?key/i;
const DEVICE_KEY_UNKNOWN = /unknown|not[_-]?found|invalid|unregistered/i;

export function isFreebuffDeviceKeyError(message: string | undefined): boolean {
  return Boolean(message) && DEVICE_KEY_ERROR.test(message!) && DEVICE_KEY_UNKNOWN.test(message!);
}

export function freebuffForgetDeviceKeyRegistration(
  token: string,
  url: string,
  accountId?: string,
): void {
  void (async () => {
    const scope = await scopeFor({
      token,
      method: "GET",
      url,
      ...(accountId !== undefined ? { accountId } : {}),
    });
    retryAfter.delete(scope);
    const key = await (stored ?? loadStoredKey());
    if (!key || !(scope in key.record.registrations)) return;
    delete key.record.registrations[scope];
    await persist(key.record);
  })().catch(() => undefined);
}
