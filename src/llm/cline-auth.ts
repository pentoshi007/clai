import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1";
export const CLINE_WORKOS_API_BASE_URL = "https://api.workos.com";
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

export const CLINE_CLIENT_VERSION = process.env.CLINE_CLIENT_VERSION?.trim() || "4.1.20";
export const CLINE_CORE_VERSION = process.env.CLINE_CORE_VERSION?.trim() || "0.0.85";

const CLINE_CLIENT_TYPE = process.env.CLINE_CLIENT_TYPE?.trim() || "cline-desktop";
const CLINE_PLATFORM = process.env.CLINE_PLATFORM?.trim() || CLINE_CLIENT_TYPE;
const CLINE_PLATFORM_VERSION = process.env.CLINE_PLATFORM_VERSION?.trim() || CLINE_CLIENT_VERSION;

export const CLINE_AUTH_HEADERS: Record<string, string> = {
  "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
  "X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
  "X-CLIENT-VERSION": CLINE_CLIENT_VERSION,
  "X-PLATFORM": CLINE_PLATFORM,
  "X-PLATFORM-VERSION": CLINE_PLATFORM_VERSION,
  "X-Title": "Cline",
  "HTTP-Referer": "https://cline.bot",
  "X-IS-MULTIROOT": "false",
};

export const CLINE_REQUEST_HEADERS: Record<string, string> = {
  ...CLINE_AUTH_HEADERS,
  "X-CORE-VERSION": CLINE_CORE_VERSION,
};

export interface ClineDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface ClineOAuthTokens {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt?: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export class ClineAuthError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly errorCode?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ClineAuthError";
  }

  isLikelyInvalidGrant(): boolean {
    if (/invalid_grant|invalid_token|unauthorized|revoked|expired|access_denied|policy_denied/i.test(this.errorCode ?? "")) {
      return true;
    }
    return (
      [400, 401, 403].includes(this.status ?? 0) &&
      /invalid|expired|revoked|unauthorized/i.test(this.message)
    );
  }
}

async function readAuthPayload(response: Response): Promise<Record<string, unknown> | undefined> {
  const body = await response.text().catch(() => "");
  try {
    return asRecord(JSON.parse(body));
  } catch {
    return undefined;
  }
}

function authFailure(
  response: Response,
  operation: string,
  payload?: Record<string, unknown>,
): ClineAuthError {
  const errorCode =
    typeof payload?.error === "string"
      ? payload.error
      : typeof payload?.code === "string"
        ? payload.code
        : undefined;
  const detail =
    typeof payload?.error_description === "string"
      ? payload.error_description
      : typeof payload?.message === "string"
        ? payload.message
        : errorCode ?? (response.status === 401 ? "Unauthorized" : "request failed");
  const requestId = response.headers.get("x-request-id") ?? undefined;
  let message = `${operation} failed (${response.status}): ${detail}`;
  if (errorCode === "policy_denied") {
    message = `Cline AuthKit denied sign-in by policy (policy_denied). No token was issued: ${detail}`;
  } else if (errorCode === "access_denied") {
    message = `Cline authentication was denied (access_denied): ${detail}`;
  }
  return new ClineAuthError(
    requestId ? `${message} [request ${requestId}]` : message,
    response.status,
    errorCode,
    requestId,
  );
}

function parseExpiresAt(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const epoch = Date.parse(value);
    if (!Number.isNaN(epoch)) return epoch;
  }
  return undefined;
}

export async function startClineDeviceAuth(): Promise<ClineDeviceAuthStart> {
  const response = await fetch(
    `${CLINE_WORKOS_API_BASE_URL}/user_management/authorize/device`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const json = asRecord(await response.json().catch(() => ({})));
  const deviceCode = typeof json?.device_code === "string" ? json.device_code : "";
  const userCode = typeof json?.user_code === "string" ? json.user_code : "";
  const verificationUri =
    typeof json?.verification_uri_complete === "string"
      ? json.verification_uri_complete
      : typeof json?.verification_uri === "string"
        ? json.verification_uri
        : "";
  if (!response.ok) {
    throw authFailure(response, "WorkOS device authorization", json);
  }
  if (!deviceCode || !userCode || !verificationUri) {
    throw new ClineAuthError("WorkOS device authorization returned an incomplete response");
  }
  const expiresIn = json && typeof json.expires_in === "number" ? json.expires_in : 300;
  const interval = json && typeof json.interval === "number" ? json.interval : 5;
  return {
    deviceCode,
    userCode,
    verificationUrl: verificationUri,
    expiresInSeconds: expiresIn,
    pollIntervalSeconds: interval,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function registerWorkOSTokensWithCline(
  accessToken: string,
  refreshToken: string,
): Promise<ClineOAuthTokens> {
  const response = await fetch(`${CLINE_API_BASE_URL}/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...CLINE_AUTH_HEADERS,
    },
    body: JSON.stringify({ accessToken, refreshToken }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await readAuthPayload(response);
  if (!response.ok) {
    throw authFailure(response, "Cline token registration", payload);
  }
  const data = asRecord(payload?.data);
  const registeredAccessToken =
    typeof data?.accessToken === "string" ? data.accessToken : "";
  const registeredRefreshToken =
    typeof data?.refreshToken === "string" ? data.refreshToken : "";
  const expiresAt = parseExpiresAt(data?.expiresAt);
  if (!registeredAccessToken || !registeredRefreshToken || expiresAt === undefined) {
    throw new ClineAuthError("Cline token registration returned incomplete credentials");
  }
  return {
    accessToken: toClineAccessToken(registeredAccessToken),
    refreshToken: registeredRefreshToken,
    expiresAt,
  };
}

const refreshesInFlight = new Map<string, Promise<ClineOAuthTokens>>();

async function requestClineTokenRefresh(
  refreshToken: string,
): Promise<ClineOAuthTokens> {
  let response: Response;
  try {
    response = await fetch(`${CLINE_API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...CLINE_AUTH_HEADERS,
      },
      body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new ClineAuthError(
      `Cline token refresh request failed: ${error instanceof Error ? error.message : "network error"}`,
    );
  }
  const payload = await readAuthPayload(response);
  if (!response.ok) {
    throw authFailure(response, "Cline token refresh", payload);
  }
  const data = asRecord(payload?.data);
  const accessToken = typeof data?.accessToken === "string" ? data.accessToken : "";
  const expiresAt = parseExpiresAt(data?.expiresAt);
  if (!accessToken || expiresAt === undefined) {
    throw new ClineAuthError("Cline token refresh returned incomplete credentials");
  }
  return {
    accessToken: toClineAccessToken(accessToken),
    refreshToken:
      typeof data?.refreshToken === "string" ? data.refreshToken : refreshToken,
    expiresAt,
  };
}

export function refreshClineToken(refreshToken: string): Promise<ClineOAuthTokens> {
  const inFlight = refreshesInFlight.get(refreshToken);
  if (inFlight) return inFlight;
  const refresh = requestClineTokenRefresh(refreshToken);
  refreshesInFlight.set(refreshToken, refresh);
  return refresh.finally(() => {
    if (refreshesInFlight.get(refreshToken) === refresh) {
      refreshesInFlight.delete(refreshToken);
    }
  });
}

type ClineDevicePollResult =
  | { state: "pending" }
  | { state: "slow-down" }
  | { state: "complete"; tokens: ClineOAuthTokens };

async function requestClineDevicePoll(start: ClineDeviceAuthStart): Promise<Response> {
  return fetch(`${CLINE_WORKOS_API_BASE_URL}/user_management/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: start.deviceCode,
      client_id: CLINE_WORKOS_CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function consumeClineDevicePoll(response: Response): Promise<ClineDevicePollResult> {
  const payload = asRecord(await response.json().catch(() => ({})));
  if (response.ok && typeof payload?.access_token === "string") {
    const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
    if (!refreshToken) {
      throw new ClineAuthError("WorkOS device authorization returned no refresh token");
    }
    return {
      state: "complete",
      tokens: await registerWorkOSTokensWithCline(payload.access_token, refreshToken),
    };
  }
  if (response.ok) {
    throw new ClineAuthError("WorkOS device authorization returned incomplete credentials");
  }
  const error = typeof payload?.error === "string" ? payload.error : "";
  if (error === "authorization_pending") return { state: "pending" };
  if (error === "slow_down") return { state: "slow-down" };
  if (error === "expired_token") {
    throw new ClineAuthError("Cline authentication code expired — start again", response.status, error);
  }
  throw authFailure(response, "Cline authentication", payload);
}

export async function pollClineDeviceAuth(
  start: ClineDeviceAuthStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
  } = {},
): Promise<ClineOAuthTokens> {
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  let interval = Math.max(1, start.pollIntervalSeconds) * 1000;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error("Cline authentication cancelled");
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) break;
    options.onPending?.(remaining);
    const result = await consumeClineDevicePoll(await requestClineDevicePoll(start));
    if (result.state === "complete") return result.tokens;
    if (result.state === "slow-down") interval += 5_000;
    await sleep(interval);
  }
  throw new ClineAuthError("Cline authentication code expired — start again");
}

export function isClineOAuthToken(value: string): boolean {
  return value.toLowerCase().startsWith("workos:");
}

function toClineAccessToken(value: string): string {
  return isClineOAuthToken(value) ? `workos:${value.slice(7)}` : `workos:${value}`;
}

function sameClineAccessToken(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/^workos:/i, "");
  const normalizedRight = right.replace(/^workos:/i, "");
  return normalizedLeft === normalizedRight;
}

export async function readClineStoredAuth(): Promise<
  { accessToken: string; refreshToken?: string | undefined; expiresAt?: number | undefined } | undefined
> {
  for (const path of candidateClineCredentialPaths()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const providers = asRecord(asRecord(parsed)?.providers);
    const clineEntry = asRecord(providers?.cline ?? providers?.["cline-pass"]);
    const authRec = asRecord(asRecord(clineEntry?.settings)?.auth ?? clineEntry?.auth);
    if (!authRec) continue;
    const accessToken =
      typeof authRec.accessToken === "string" ? authRec.accessToken : "";
    if (!accessToken) continue;
    return {
      accessToken,
      refreshToken:
        typeof authRec.refreshToken === "string" ? authRec.refreshToken : undefined,
      expiresAt: parseExpiresAt(authRec.expiresAt),
    };
  }
  return undefined;
}

export async function getClineRefreshToken(
  currentKey: string,
  refreshToken?: string,
): Promise<string | undefined> {
  if (refreshToken) return refreshToken;
  const stored = await readClineStoredAuth();
  if (!stored?.refreshToken || !sameClineAccessToken(currentKey, stored.accessToken)) {
    return undefined;
  }
  return stored.refreshToken;
}

export async function maybeRefreshClineToken(
  currentKey: string,
  refreshToken?: string,
  onError?: ((message: string) => void) | undefined,
): Promise<ClineOAuthTokens | undefined> {
  const token = await getClineRefreshToken(currentKey, refreshToken);
  if (!token) return undefined;
  try {
    return await refreshClineToken(token);
  } catch (error) {
    onError?.(error instanceof Error ? error.message : "request failed");
    return undefined;
  }
}

export async function verifyClineToken(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${CLINE_API_BASE_URL}/users/me`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...CLINE_AUTH_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function candidateClineCredentialPaths(): string[] {
  const home = homedir();
  const os = platform();
  const paths: string[] = [];
  if (process.env.CLINE_DATA_DIR) {
    paths.push(join(process.env.CLINE_DATA_DIR, "settings", "providers.json"));
  }
  paths.push(join(home, ".cline", "data", "settings", "providers.json"));
  if (os === "darwin") {
    paths.push(
      join(home, "Library", "Application Support", "Cline", "providers.json"),
    );
  } else if (os === "linux") {
    paths.push(join(home, ".config", "Cline", "providers.json"));
  } else if (os === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    paths.push(join(appData, "Cline", "providers.json"));
  }
  return paths;
}

export async function importExistingClineAuth(): Promise<ClineOAuthTokens | undefined> {
  for (const path of candidateClineCredentialPaths()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const providers = asRecord(asRecord(parsed)?.providers);
    const clineEntry = asRecord(providers?.cline ?? providers?.["cline-pass"]);
    const authRec = asRecord(asRecord(clineEntry?.settings)?.auth ?? clineEntry?.auth);
    if (!authRec) continue;
    let accessToken = typeof authRec.accessToken === "string" ? authRec.accessToken : "";
    if (!accessToken) continue;
    let refreshToken =
      typeof authRec.refreshToken === "string" ? authRec.refreshToken : undefined;
    let expiresAt = parseExpiresAt(authRec.expiresAt);
    if (expiresAt !== undefined && expiresAt < Date.now() && refreshToken) {
      try {
        const refreshed = await refreshClineToken(refreshToken);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken;
        expiresAt = refreshed.expiresAt;
      } catch {
      }
    }
    if (!(await verifyClineToken(accessToken))) continue;
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  return undefined;
}

export async function importExistingClineKey(): Promise<string | undefined> {
  return (await importExistingClineAuth())?.accessToken;
}
