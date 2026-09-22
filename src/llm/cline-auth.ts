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
  expiresAt?: number | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

export async function registerWorkOSTokensWithCline(
  accessToken: string,
  refreshToken: string,
): Promise<ClineOAuthTokens | undefined> {
  try {
    const response = await fetch(`${CLINE_API_BASE_URL}/auth/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...CLINE_REQUEST_HEADERS,
      },
      body: JSON.stringify({ accessToken, refreshToken }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) return undefined;
    const json = asRecord(await response.json().catch(() => ({})));
    const data = asRecord(json?.data);
    if (!data || typeof data.accessToken !== "string") return undefined;
    const expiresAt = parseExpiresAt(data.expiresAt) ?? (Date.now() + 3600 * 1000);
    return {
      accessToken: toClineAccessToken(data.accessToken),
      refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : refreshToken,
      expiresAt,
    };
  } catch {
    return undefined;
  }
}

export async function refreshClineToken(
  refreshToken: string,
): Promise<ClineOAuthTokens> {
  try {
    const response = await fetch(`${CLINE_API_BASE_URL}/auth/refresh`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...CLINE_REQUEST_HEADERS,
      },
      body: JSON.stringify({
        refreshToken,
        grantType: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const json = asRecord(await response.json().catch(() => ({})));
      const data = asRecord(json?.data);
      if (data && typeof data.accessToken === "string") {
        const expiresAt = parseExpiresAt(data.expiresAt) ?? (Date.now() + 3600 * 1000);
        return {
          accessToken: toClineAccessToken(data.accessToken),
          refreshToken:
            typeof data.refreshToken === "string" ? data.refreshToken : refreshToken,
          expiresAt,
        };
      }
    }
  } catch {
  }

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
  const newRefreshToken =
    typeof json.refresh_token === "string" ? json.refresh_token : refreshToken;
  const registered = await registerWorkOSTokensWithCline(
    json.access_token,
    newRefreshToken,
  );
  if (registered) return registered;
  return {
    accessToken: toClineAccessToken(json.access_token),
    refreshToken: newRefreshToken,
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
      const rawRefreshToken =
        typeof json.refresh_token === "string" ? json.refresh_token : undefined;
      if (rawRefreshToken) {
        const registered = await registerWorkOSTokensWithCline(
          json.access_token,
          rawRefreshToken,
        );
        if (registered) return registered;
      }
      return {
        accessToken: toClineAccessToken(json.access_token),
        refreshToken: rawRefreshToken,
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
  return value.startsWith("workos:") || value.length >= 40;
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

export async function maybeRefreshClineToken(
  currentKey: string,
  refreshToken?: string,
  onError?: ((message: string) => void) | undefined,
): Promise<ClineOAuthTokens | undefined> {
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
