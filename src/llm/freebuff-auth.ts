import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ProviderError } from "./http.js";

export const FREEBUFF_WEB_BASE_URL = "https://freebuff.com";
export const FREEBUFF_API_BASE_URL = "https://www.codebuff.com";
export const FREEBUFF_LOGIN_POLL_INTERVAL_MS = 5_000;
export const FREEBUFF_LOGIN_TIMEOUT_MS = 5 * 60_000;

export interface FreebuffAuthUser {
  readonly authToken: string;
  readonly id?: string | undefined;
  readonly email?: string | undefined;
  readonly name?: string | null | undefined;
}

export interface FreebuffDeviceAuthStart {
  readonly loginUrl: string;
  readonly fingerprintId: string;
  readonly fingerprintHash: string;
  readonly expiresAt: string;
}

export interface FreebuffLoginResult {
  readonly token: string;
  readonly user: FreebuffAuthUser;
}

export interface FreebuffAuthDeps {
  readonly fetch?: typeof fetch | undefined;
  readonly sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly webBaseUrl?: string | undefined;
  readonly apiBaseUrl?: string | undefined;
}

interface FreebuffImportOptions {
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly homeDir?: string | undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function payloadOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeBody(payload: unknown): string | undefined {
  if (payload === undefined) return undefined;
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "").slice(0, 1_000);
}

function apiError(label: string, response: Response, payload: unknown): ProviderError {
  const body = safeBody(payload);
  return new ProviderError(
    `${label} failed (${response.status}${body ? `: ${body}` : ""})`,
    response.status,
    body,
  );
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs = 30_000): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function validBrowserUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    return url.protocol === "https:" || (url.protocol === "http:" && loopback)
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function authUser(value: unknown): FreebuffAuthUser | undefined {
  const record = recordOf(value);
  if (!record) return undefined;
  const token = record.authToken;
  if (!isFreebuffToken(token)) return undefined;
  return {
    authToken: token.trim(),
    ...(typeof record.id === "string" ? { id: record.id } : {}),
    ...(typeof record.email === "string" ? { email: record.email } : {}),
    ...(typeof record.name === "string" || record.name === null ? { name: record.name } : {}),
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function isFreebuffToken(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 8 && value.length <= 16_384 && !/[\s\u0000-\u001f\u007f]/.test(value);
}

export function createFreebuffFingerprintId(): string {
  return `codebuff-cli-${randomBytes(6).toString("base64url").slice(0, 8)}`;
}

export function isFreebuffHeadless(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (env.SSH_CLIENT || env.SSH_TTY || env.SSH_CONNECTION || env.CODESPACES) return true;
  return platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}

export async function startFreebuffDeviceAuth(
  options: { fingerprintId?: string | undefined; signal?: AbortSignal | undefined } = {},
  deps: FreebuffAuthDeps = {},
): Promise<FreebuffDeviceAuthStart> {
  const fingerprintId = options.fingerprintId ?? createFreebuffFingerprintId();
  const response = await (deps.fetch ?? fetch)(
    `${deps.webBaseUrl ?? FREEBUFF_WEB_BASE_URL}/api/auth/cli/code`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprintId }),
      signal: combinedSignal(options.signal),
    },
  );
  const payload = await payloadOf(response);
  if (!response.ok) throw apiError("Freebuff login URL request", response, payload);
  const data = recordOf(payload);
  const loginUrl = validBrowserUrl(data?.loginUrl);
  const fingerprintHash = data?.fingerprintHash;
  const rawExpiresAt = data?.expiresAt;
  const expiresAt =
    typeof rawExpiresAt === "number" && Number.isFinite(rawExpiresAt)
      ? String(rawExpiresAt)
      : typeof rawExpiresAt === "string" && rawExpiresAt.length > 0
        ? rawExpiresAt
        : undefined;
  if (!loginUrl || typeof fingerprintHash !== "string" || expiresAt === undefined) {
    throw new ProviderError("Freebuff returned an invalid login challenge. Try `clai auth freebuff` again.");
  }
  return { loginUrl, fingerprintId, fingerprintHash, expiresAt };
}

export async function pollFreebuffDeviceAuth(
  start: FreebuffDeviceAuthStart,
  options: { signal?: AbortSignal | undefined; timeoutMs?: number | undefined } = {},
  deps: FreebuffAuthDeps = {},
): Promise<FreebuffLoginResult> {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? FREEBUFF_LOGIN_TIMEOUT_MS);
  let lastStatus: number | undefined;
  while (now() < deadline) {
    options.signal?.throwIfAborted();
    const url = new URL("/api/auth/cli/status", deps.webBaseUrl ?? FREEBUFF_WEB_BASE_URL);
    url.searchParams.set("fingerprintId", start.fingerprintId);
    url.searchParams.set("fingerprintHash", start.fingerprintHash);
    url.searchParams.set("expiresAt", start.expiresAt);
    try {
      const response = await fetchImpl(url, { signal: combinedSignal(options.signal) });
      lastStatus = response.status;
      const payload = await payloadOf(response);
      if (response.ok) {
        const user = authUser(recordOf(payload)?.user);
        if (user) return { token: user.authToken, user };
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
    }
    await sleep(FREEBUFF_LOGIN_POLL_INTERVAL_MS, options.signal);
  }
  throw new ProviderError(
    `Freebuff login timed out${lastStatus && lastStatus !== 401 ? ` after status ${lastStatus}` : ""}. Run \`clai auth freebuff\` to try again.`,
    lastStatus,
  );
}

export async function validateFreebuffToken(
  token: string,
  options: { signal?: AbortSignal | undefined } = {},
  deps: FreebuffAuthDeps = {},
): Promise<void> {
  if (!isFreebuffToken(token)) throw new ProviderError("Freebuff authentication token is malformed.", 401);
  const url = new URL("/api/v1/me", deps.apiBaseUrl ?? FREEBUFF_API_BASE_URL);
  url.searchParams.set("fields", "id,email");
  const response = await (deps.fetch ?? fetch)(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: combinedSignal(options.signal),
  });
  const payload = await payloadOf(response);
  if (!response.ok) {
    const error = apiError("Freebuff authentication", response, payload);
    throw new ProviderError(`${error.message}. Run \`clai auth freebuff\` to sign in again.`, error.status, error.body);
  }
}

export async function importExistingFreebuffToken(
  options: FreebuffImportOptions = {},
): Promise<{ token: string; source: string } | undefined> {
  const env = options.env ?? process.env;
  for (const [name, value] of [
    ["FREEBUFF_API_KEY", env.FREEBUFF_API_KEY],
    ["CODEBUFF_API_KEY", env.CODEBUFF_API_KEY],
  ] as const) {
    if (isFreebuffToken(value)) return { token: value.trim(), source: name };
  }
  const configured = env.FREEBUFF_CONFIG_DIR;
  const configDir = configured && isAbsolute(configured)
    ? configured
    : join(options.homeDir ?? homedir(), ".config", "manicode");
  const path = join(configDir, "credentials.json");
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    const user = authUser(recordOf(parsed)?.default);
    return user ? { token: user.authToken, source: path } : undefined;
  } catch {
    return undefined;
  }
}
