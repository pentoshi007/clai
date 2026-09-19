
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const CLINE_API_BASE_URL = "https://api.cline.bot/api/v1";
export const CLINE_WORKOS_API_BASE_URL = "https://api.workos.com";
export const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

export const CLINE_CLIENT_VERSION = "3.0.52";

export const CLINE_REQUEST_HEADERS: Record<string, string> = {
  "User-Agent": `Cline/${CLINE_CLIENT_VERSION}`,
  "X-CLIENT-TYPE": "cline-desktop",
  "X-Title": "Cline",
  "HTTP-Referer": "https://cline.bot",
  "X-IS-MULTIROOT": "false",
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
  expiresAt?: number | undefined; // ms epoch
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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
  if (!response.ok || !deviceCode || !userCode || !verificationUri) {
    throw new Error("Invalid WorkOS device authorization response");
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

export async function refreshClineToken(
  refreshToken: string,
): Promise<ClineOAuthTokens> {
  const response = await fetch(
    `${CLINE_WORKOS_API_BASE_URL}/user_management/authenticate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLINE_WORKOS_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const json = asRecord(await response.json().catch(() => ({})));
  if (!response.ok || typeof json?.access_token !== "string") {
    const description =
      typeof json?.error_description === "string"
        ? json.error_description
        : typeof json?.error === "string"
          ? json.error
          : "";
    throw new Error(
      `Cline token refresh failed (${response.status})${description ? `: ${description}` : ""}`,
    );
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  return {
    accessToken: toClineAccessToken(json.access_token),
    refreshToken:
      typeof json.refresh_token === "string" ? json.refresh_token : refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
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
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("Cline authentication cancelled");
    }
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      throw new Error("Cline authentication code expired — start again");
    }
    options.onPending?.(remaining);
    const response = await fetch(
      `${CLINE_WORKOS_API_BASE_URL}/user_management/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: start.deviceCode,
          client_id: CLINE_WORKOS_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const json = asRecord(await response.json().catch(() => ({})));
    if (response.ok && typeof json?.access_token === "string") {
      const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
      return {
        accessToken: toClineAccessToken(json.access_token),
        refreshToken:
          typeof json.refresh_token === "string" ? json.refresh_token : undefined,
        expiresAt: Date.now() + expiresIn * 1000,
      };
    }
    const error = typeof json?.error === "string" ? json.error : "";
    if (error === "authorization_pending") {
      await sleep(interval);
      continue;
    }
    if (error === "slow_down") {
      interval += 5_000;
      await sleep(interval);
      continue;
    }
    if (error === "expired_token" || error === "access_denied") {
      throw new Error(
        error === "access_denied"
          ? "Cline authentication was denied"
          : "Cline authentication code expired — start again",
      );
    }
    const description =
      typeof json?.error_description === "string" ? json.error_description : "";
    throw new Error(
      `Cline authentication failed (${response.status})${description ? `: ${description}` : ""}`,
    );
  }
}

export function isClineOAuthToken(value: string): boolean {
  return value.startsWith("workos:");
}

function toClineAccessToken(value: string): string {
  return isClineOAuthToken(value) ? value : `workos:${value}`;
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
    const auth = asRecord(
      asRecord(asRecord(asRecord(parsed)?.providers)?.cline)?.settings,
    )?.auth;
    const rec = asRecord(auth);
    if (!rec) continue;
    const accessToken =
      typeof rec.accessToken === "string" ? rec.accessToken : "";
    if (!accessToken) continue;
    return {
      accessToken,
      refreshToken:
        typeof rec.refreshToken === "string" ? rec.refreshToken : undefined,
      expiresAt: typeof rec.expiresAt === "number" ? rec.expiresAt : undefined,
    };
  }
  return undefined;
}

export async function maybeRefreshClineToken(
  currentKey: string,
  refreshToken?: string,
  onError?: ((message: string) => void) | undefined,
): Promise<ClineOAuthTokens | undefined> {
  if (!isClineOAuthToken(currentKey)) return undefined;
  let token = refreshToken;
  if (!token) {
    const stored = await readClineStoredAuth();
    token = stored?.refreshToken;
  }
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
        ...CLINE_REQUEST_HEADERS,
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
  const paths = [join(home, ".cline", "data", "settings", "providers.json")];
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
    const authRec = asRecord(
      asRecord(asRecord(asRecord(parsed)?.providers)?.cline)?.settings,
    )?.auth;
    const auth = asRecord(authRec);
    if (!auth) continue;
    let accessToken = typeof auth.accessToken === "string" ? auth.accessToken : "";
    if (!accessToken) continue;
    let refreshToken =
      typeof auth.refreshToken === "string" ? auth.refreshToken : undefined;
    let expiresAt = typeof auth.expiresAt === "number" ? auth.expiresAt : undefined;
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
