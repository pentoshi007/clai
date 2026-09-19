import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLIENT_VERSION = "0.147.0";
export const CODEX_SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";

const CODEX_KEY_PREFIX = "codex:";

export interface CodexCredential {
  accessToken: string;
  refreshToken?: string | undefined;
  accountId: string;
  expiresAt?: number | undefined;
}

export interface CodexDeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export function isCodexOAuthToken(value: string): boolean {
  return value.startsWith(CODEX_KEY_PREFIX);
}

export function encodeCodexKey(credential: CodexCredential): string {
  const payload = {
    a: credential.accessToken,
    r: credential.refreshToken ?? "",
    i: credential.accountId,
    e: credential.expiresAt ?? 0,
  };
  return CODEX_KEY_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCodexKey(value: string): CodexCredential | undefined {
  if (!isCodexOAuthToken(value)) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(CODEX_KEY_PREFIX.length), "base64url").toString("utf8"),
    ) as { a?: unknown; r?: unknown; i?: unknown; e?: unknown };
    if (typeof parsed.a !== "string" || !parsed.a) return undefined;
    if (typeof parsed.i !== "string" || !parsed.i) return undefined;
    return {
      accessToken: parsed.a,
      accountId: parsed.i,
      ...(typeof parsed.r === "string" && parsed.r ? { refreshToken: parsed.r } : {}),
      ...(typeof parsed.e === "number" && parsed.e > 0 ? { expiresAt: parsed.e } : {}),
    };
  } catch {
    return undefined;
  }
}

export function codexRequestHeaders(
  accountId: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    "chatgpt-account-id": accountId,
    originator: CODEX_ORIGINATOR,
    "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
    "session-id": crypto.randomUUID(),
    "x-client-request-id": crypto.randomUUID(),
    ...extra,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return undefined;
  }
}

export function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  const auth = asRecord(jwtClaims(idToken)?.["https://api.openai.com/auth"]);
  const accountId = auth?.chatgpt_account_id;
  return typeof accountId === "string" && accountId ? accountId : undefined;
}

export function expiresAtFromAccessToken(accessToken: string): number | undefined {
  const exp = jwtClaims(accessToken)?.exp;
  return typeof exp === "number" && exp > 0 ? exp * 1000 : undefined;
}

async function postToken(
  body: Record<string, string>,
  contentType: string,
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body:
      contentType === "application/json"
        ? JSON.stringify(body)
        : new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = asRecord(await response.json().catch(() => ({}))) ?? {};
  return { ok: response.ok, status: response.status, json };
}

function tokenError(json: Record<string, unknown>, status: number): string {
  const description =
    typeof json.error_description === "string"
      ? json.error_description
      : typeof json.error === "string"
        ? json.error
        : "";
  return `${status}${description ? `: ${description}` : ""}`;
}

function credentialFromTokens(
  json: Record<string, unknown>,
  fallback: CodexCredential | undefined,
): CodexCredential {
  const accessToken = typeof json.access_token === "string" ? json.access_token : "";
  if (!accessToken) throw new Error("Codex token response missing access_token");
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token
      ? json.refresh_token
      : fallback?.refreshToken;
  const accountId =
    accountIdFromIdToken(typeof json.id_token === "string" ? json.id_token : undefined) ??
    fallback?.accountId;
  if (!accountId) throw new Error("Codex token response missing chatgpt account id");
  const expiresAt = expiresAtFromAccessToken(accessToken) ?? fallback?.expiresAt;
  return {
    accessToken,
    accountId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

export async function startCodexDeviceAuth(): Promise<CodexDeviceAuthStart> {
  const response = await fetch(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = asRecord(await response.json().catch(() => ({})));
  const deviceAuthId =
    typeof json?.device_auth_id === "string" ? json.device_auth_id : "";
  const userCode = typeof json?.user_code === "string" ? json.user_code : "";
  if (!response.ok || !deviceAuthId || !userCode) {
    throw new Error("Invalid Codex device authorization response");
  }
  const intervalRaw = json?.interval;
  const interval =
    typeof intervalRaw === "number"
      ? intervalRaw
      : typeof intervalRaw === "string"
        ? Number.parseInt(intervalRaw, 10)
        : 5;
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${CODEX_AUTH_BASE_URL}/codex/device`,
    expiresInSeconds: 900,
    pollIntervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exchangeDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
): Promise<CodexCredential> {
  const body = {
    grant_type: "authorization_code",
    client_id: CODEX_CLIENT_ID,
    code: authorizationCode,
    redirect_uri: `${CODEX_AUTH_BASE_URL}/deviceauth/callback`,
    code_verifier: codeVerifier,
  };
  let result = await postToken(body, "application/json");
  if (!result.ok && result.status === 400) {
    result = await postToken(body, "application/x-www-form-urlencoded");
  }
  if (!result.ok) {
    throw new Error(`Codex token exchange failed (${tokenError(result.json, result.status)})`);
  }
  return credentialFromTokens(result.json, undefined);
}

export async function pollCodexDeviceAuth(
  start: CodexDeviceAuthStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
  } = {},
): Promise<CodexCredential> {
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  const interval = Math.max(1, start.pollIntervalSeconds) * 1000;
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("Codex authentication cancelled");
    }
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      throw new Error("Codex authentication code expired — start again");
    }
    options.onPending?.(remaining);
    const response = await fetch(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_auth_id: start.deviceAuthId,
        user_code: start.userCode,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) {
      const json = asRecord(await response.json().catch(() => ({})));
      const code =
        typeof json?.authorization_code === "string" ? json.authorization_code : "";
      const verifier =
        typeof json?.code_verifier === "string" ? json.code_verifier : "";
      if (!code || !verifier) {
        throw new Error("Codex device authorization returned no code");
      }
      return exchangeDeviceCode(code, verifier);
    }
    if (response.status === 403 || response.status === 404) {
      await sleep(interval);
      continue;
    }
    throw new Error(`Codex device authorization failed (HTTP ${response.status})`);
  }
}

export async function refreshCodexToken(
  refreshToken: string,
  fallback?: CodexCredential | undefined,
): Promise<CodexCredential> {
  const result = await postToken(
    {
      grant_type: "refresh_token",
      client_id: CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    },
    "application/json",
  );
  if (!result.ok) {
    throw new Error(`Codex token refresh failed (${tokenError(result.json, result.status)})`);
  }
  return credentialFromTokens(result.json, fallback);
}

export async function verifyCodexCredential(credential: CodexCredential): Promise<boolean> {
  try {
    const response = await fetch(
      `${CODEX_API_BASE_URL}/models?client_version=${CODEX_CLIENT_VERSION}`,
      {
        headers: {
          authorization: `Bearer ${credential.accessToken}`,
          ...codexRequestHeaders(credential.accountId),
        },
        signal: AbortSignal.timeout(15_000),
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export function candidateCodexCredentialPaths(): string[] {
  const home = homedir();
  const os = platform();
  const paths: string[] = [];
  if (os === "win32") {
    const profile = process.env.USERPROFILE ?? home;
    paths.push(join(profile, ".codex", "auth.json"));
  } else {
    paths.push(join(home, ".codex", "auth.json"));
    if (os === "darwin") {
      paths.push(join(home, "Library", "Application Support", "Codex", "auth.json"));
    } else if (os === "linux") {
      paths.push(join(home, ".config", "codex", "auth.json"));
    }
  }
  return paths;
}

export async function readCodexStoredAuth(): Promise<CodexCredential | undefined> {
  for (const path of candidateCodexCredentialPaths()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const tokens = asRecord(asRecord(parsed)?.tokens);
    if (!tokens) continue;
    const accessToken =
      typeof tokens.access_token === "string" ? tokens.access_token : "";
    if (!accessToken) continue;
    const accountId =
      typeof tokens.account_id === "string" && tokens.account_id
        ? tokens.account_id
        : accountIdFromIdToken(
            typeof tokens.id_token === "string" ? tokens.id_token : undefined,
          );
    if (!accountId) continue;
    const refreshToken =
      typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
    const expiresAt = expiresAtFromAccessToken(accessToken);
    return {
      accessToken,
      accountId,
      ...(refreshToken ? { refreshToken } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  return undefined;
}

export async function maybeRefreshCodexCredential(
  currentKey: string,
): Promise<string | undefined> {
  const credential = decodeCodexKey(currentKey);
  if (!credential?.refreshToken) return undefined;
  try {
    const refreshed = await refreshCodexToken(credential.refreshToken, credential);
    return encodeCodexKey(refreshed);
  } catch {
    return undefined;
  }
}

export async function importExistingCodexKey(): Promise<string | undefined> {
  const stored = await readCodexStoredAuth();
  if (!stored) return undefined;
  let credential = stored;
  if (credential.expiresAt !== undefined && credential.expiresAt < Date.now() && credential.refreshToken) {
    try {
      credential = await refreshCodexToken(credential.refreshToken, credential);
    } catch {
    }
  }
  if (await verifyCodexCredential(credential)) return encodeCodexKey(credential);
  return undefined;
}
