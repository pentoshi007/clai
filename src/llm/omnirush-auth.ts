import { arch, homedir, hostname, platform, release } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const OMNIRUSH_DEFAULT_ORIGIN = "https://omnirush.ai/omnirush";
export const OMNIRUSH_CONSOLE_URL = "https://omnirush.ai/console";
export const OMNIRUSH_CLI_VERSION = "1.0.5";
export const OMNIRUSH_DEFAULT_MODEL = "gpt-6-astra";

export function omnirushOrigin(): string {
  const direct = (process.env.OMNIRUSH_ORIGIN ?? "").trim().replace(/\/+$/, "");
  if (direct) return direct;
  const viaGateway = (process.env.OMNIRUSH_GATEWAY_URL ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v1$/, "");
  if (viaGateway) return viaGateway;
  return OMNIRUSH_DEFAULT_ORIGIN;
}

export function omnirushGatewayUrl(): string {
  const override = (process.env.OMNIRUSH_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");
  if (override) return /\/v1$/i.test(override) ? override : `${override}/v1`;
  return `${omnirushOrigin()}/v1`;
}

export function omnirushManagerUserAgent(): string {
  return `omnirush/${OMNIRUSH_CLI_VERSION} (${process.platform}; ${process.arch})`;
}

export function omnirushGatewayUserAgent(): string {
  return `omnirush (${platform()} ${release()}; ${arch()})`;
}

export function omnirushDeviceName(): string {
  const name = (hostname() || "omnirush-cli").split(/[.\s]/)[0] ?? "";
  return name.slice(0, 64) || "omnirush-cli";
}

export function omnirushAuthFilePath(): string {
  const dir = (process.env.OMNIRUSH_DIR ?? "").trim();
  return join(dir || join(homedir(), ".omnirush"), "auth.json");
}

export interface OmnirushDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  verificationUrlComplete: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface OmnirushOAuthTokens {
  accessToken: string;
  refreshToken: string;
  gatewayUrl?: string | undefined;
}

export class OmnirushAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "OmnirushAuthError";
  }

  isLikelyInvalidGrant(): boolean {
    if (
      /refresh_token_invalid_or_expired|expired_token|revoked|account_inactive|account_pending|account_rejected/i.test(
        this.detail ?? "",
      )
    ) {
      return true;
    }
    return (
      [400, 401, 403, 409].includes(this.status ?? 0) &&
      /invalid|expired|revoked|denied/i.test(this.message)
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readPayload(response: Response): Promise<Record<string, unknown> | undefined> {
  const text = await response.text().catch(() => "");
  if (!text) return undefined;
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function detailOf(payload: Record<string, unknown> | undefined, fallback: string): string {
  const detail = payload?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (detail != null) return "invalid request";
  return fallback;
}

function managerHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { "User-Agent": omnirushManagerUserAgent(), ...extra };
}

export async function startOmnirushDeviceAuth(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OmnirushDeviceAuthStart> {
  let response: Response;
  try {
    response = await fetchImpl(`${omnirushOrigin()}/device/authorize`, {
      method: "POST",
      headers: managerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        device_name: omnirushDeviceName(),
        platform: process.platform,
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OmnirushAuthError(
      `omnirush device authorization request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  const payload = await readPayload(response);
  if (!response.ok) {
    throw new OmnirushAuthError(
      `omnirush device authorization failed (${response.status}): ${detailOf(payload, "request failed")}`,
      response.status,
      detailOf(payload, ""),
    );
  }
  const deviceCode = typeof payload?.device_code === "string" ? payload.device_code : "";
  const userCode = typeof payload?.user_code === "string" ? payload.user_code : "";
  const verificationUriComplete =
    typeof payload?.verification_uri_complete === "string"
      ? payload.verification_uri_complete
      : "";
  if (!deviceCode || !userCode || !verificationUriComplete) {
    throw new OmnirushAuthError(
      "omnirush device authorization returned an incomplete response",
    );
  }
  const expiresIn =
    typeof payload?.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : 600;
  const interval =
    typeof payload?.interval === "number" && payload.interval > 0 ? payload.interval : 5;
  return {
    deviceCode,
    userCode,
    verificationUrl:
      typeof payload?.verification_uri === "string" ? payload.verification_uri : verificationUriComplete,
    verificationUrlComplete: verificationUriComplete,
    expiresInSeconds: expiresIn,
    pollIntervalSeconds: interval,
  };
}

type DevicePollResult =
  | { state: "pending" }
  | { state: "slow-down" }
  | { state: "complete"; tokens: OmnirushOAuthTokens }
  | { state: "expired" };

async function requestDeviceToken(
  start: OmnirushDeviceAuthStart,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(`${omnirushOrigin()}/device/token`, {
    method: "POST",
    headers: managerHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ device_code: start.deviceCode }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function consumeDevicePoll(
  response: Response,
): Promise<DevicePollResult> {
  const payload = await readPayload(response);
  const detail = detailOf(payload, "");
  if (response.ok) {
    const accessToken =
      typeof payload?.access_token === "string" ? payload.access_token : "";
    const refreshToken =
      typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
    if (!accessToken || !refreshToken) {
      throw new OmnirushAuthError(
        "omnirush device authorization returned incomplete credentials",
      );
    }
    const gatewayUrl =
      typeof payload?.gateway_url === "string" && payload.gateway_url
        ? payload.gateway_url.replace(/\/+$/, "").replace(/\/v1$/, "")
        : undefined;
    return {
      state: "complete",
      tokens: { accessToken, refreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) },
    };
  }
  if (response.status === 428 || detail === "authorization_pending") {
    return { state: "pending" };
  }
  if (response.status === 429 || detail === "slow_down") return { state: "slow-down" };
  if (response.status === 400 || detail === "expired_token") return { state: "expired" };
  throw new OmnirushAuthError(
    `omnirush device token poll failed (${response.status}): ${detail || "request failed"}`,
    response.status,
    detail,
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export async function pollOmnirushDeviceAuth(
  start: OmnirushDeviceAuthStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
    fetchImpl?: typeof fetch | undefined;
  } = {},
): Promise<OmnirushOAuthTokens> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  let interval = Math.max(1, start.pollIntervalSeconds) * 1000;
  for (;;) {
    if (options.signal?.aborted) {
      throw new OmnirushAuthError("omnirush authentication cancelled");
    }
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) {
      throw new OmnirushAuthError(
        "omnirush authentication code expired — run `clai auth omnirush` again",
      );
    }
    options.onPending?.(remaining);
    const result = await consumeDevicePoll(await requestDeviceToken(start, fetchImpl));
    if (result.state === "complete") return result.tokens;
    if (result.state === "expired") {
      throw new OmnirushAuthError(
        "omnirush authentication code expired — run `clai auth omnirush` again",
      );
    }
    if (result.state === "slow-down") interval = Math.min(interval + 5_000, 30_000);
    await sleep(interval, options.signal);
  }
}

export async function refreshOmnirushToken(
  refreshToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<OmnirushOAuthTokens> {
  let response: Response;
  try {
    response = await fetchImpl(`${omnirushOrigin()}/device/refresh`, {
      method: "POST",
      headers: managerHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new OmnirushAuthError(
      `omnirush token refresh request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  const payload = await readPayload(response);
  const detail = detailOf(payload, "");
  if (!response.ok) {
    throw new OmnirushAuthError(
      `omnirush token refresh failed (${response.status}): ${detail || "request failed"}`,
      response.status,
      detail,
    );
  }
  const accessToken = typeof payload?.access_token === "string" ? payload.access_token : "";
  const nextRefreshToken =
    typeof payload?.refresh_token === "string" ? payload.refresh_token : "";
  if (!accessToken || !nextRefreshToken) {
    throw new OmnirushAuthError("omnirush token refresh returned incomplete credentials");
  }
  const gatewayUrl =
    typeof payload?.gateway_url === "string" && payload.gateway_url
      ? payload.gateway_url.replace(/\/+$/, "").replace(/\/v1$/, "")
      : undefined;
  return { accessToken, refreshToken: nextRefreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) };
}

export async function omnirushDeviceMe(
  accessToken: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetchImpl(`${omnirushOrigin()}/device/me`, {
      headers: managerHeaders({ Authorization: `Bearer ${accessToken}` }),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) return null;
    if (!response.ok) return null;
    return asRecord(await response.json().catch(() => null)) ?? null;
  } catch {
    return null;
  }
}

export async function verifyOmnirushToken(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<boolean> {
  return (await omnirushDeviceMe(token, fetchImpl)) !== null;
}

export async function validateOmnirushToken(
  token: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<void> {
  if (!(await omnirushDeviceMe(token, fetchImpl))) {
    throw new OmnirushAuthError("omnirush token is invalid or expired");
  }
}

export async function importExistingOmnirushAuth(): Promise<OmnirushOAuthTokens | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(omnirushAuthFilePath(), "utf8"));
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const accessToken = typeof record?.accessToken === "string" ? record.accessToken : "";
  const refreshToken = typeof record?.refreshToken === "string" ? record.refreshToken : "";
  if (!accessToken || !refreshToken) return undefined;
  const gatewayUrl =
    typeof record?.gatewayUrl === "string" && record.gatewayUrl
      ? record.gatewayUrl.replace(/\/+$/, "").replace(/\/v1$/, "")
      : undefined;
  return { accessToken, refreshToken, ...(gatewayUrl ? { gatewayUrl } : {}) };
}
