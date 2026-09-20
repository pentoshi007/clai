import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { currentSessionAffinity } from "./session-affinity.js";
import { CHATGPT_SUBSCRIPTION_DISPLAY_NAME } from "./provider-identity.js";

export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ORIGINATOR = "codex_cli_rs";
export const CODEX_CLIENT_VERSION = "0.0.0";
export const CODEX_SCOPE = "openid profile email offline_access";

const CODEX_KEY_PREFIX = "codex:";

export interface CodexCredential {
  accessToken: string;
  refreshToken?: string | undefined;
  accountId: string;
  expiresAt?: number | undefined;
  residency?: string | undefined;
}

let generatedCodexSessionId: string | undefined;

export function defaultCodexSessionId(): string {
  generatedCodexSessionId ??= crypto.randomUUID();
  return generatedCodexSessionId;
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
    y: credential.residency ?? "",
  };
  return CODEX_KEY_PREFIX + Buffer.from(JSON.stringify(payload)).toString("base64url");
}

export function decodeCodexKey(value: string): CodexCredential | undefined {
  if (!isCodexOAuthToken(value)) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(CODEX_KEY_PREFIX.length), "base64url").toString("utf8"),
    ) as { a?: unknown; r?: unknown; i?: unknown; e?: unknown; y?: unknown };
    if (typeof parsed.a !== "string" || !parsed.a) return undefined;
    if (typeof parsed.i !== "string" || !parsed.i) return undefined;
    const residency =
      typeof parsed.y === "string" && parsed.y
        ? parsed.y
        : extractResidency(parsed.a);
    return {
      accessToken: parsed.a,
      accountId: parsed.i,
      ...(typeof parsed.r === "string" && parsed.r ? { refreshToken: parsed.r } : {}),
      ...(typeof parsed.e === "number" && parsed.e > 0 ? { expiresAt: parsed.e } : {}),
      ...(residency ? { residency } : {}),
    };
  } catch {
    return undefined;
  }
}

export function codexRequestHeaders(
  accountId: string,
  extra: Record<string, string> = {},
  residency?: string,
): Record<string, string> {
  const session = currentSessionAffinity();
  return {
    "chatgpt-account-id": accountId,
    originator: CODEX_ORIGINATOR,
    "openai-beta": "responses=experimental",
    "User-Agent": `${CODEX_ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
    "session-id": session ?? defaultCodexSessionId(),
    "x-client-request-id": crypto.randomUUID(),
    ...(residency ? { "x-openai-internal-codex-residency": residency } : {}),
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

export function extractAccountIdFromClaims(claims: Record<string, unknown> | undefined): string | undefined {
  if (!claims) return undefined;
  if (typeof claims.chatgpt_account_id === "string" && claims.chatgpt_account_id) {
    return claims.chatgpt_account_id;
  }
  const auth = asRecord(claims["https://api.openai.com/auth"]);
  if (typeof auth?.chatgpt_account_id === "string" && auth.chatgpt_account_id) {
    return auth.chatgpt_account_id;
  }
  const orgs = claims.organizations;
  if (Array.isArray(orgs) && orgs.length > 0) {
    const first = asRecord(orgs[0]);
    if (typeof first?.id === "string" && first.id) return first.id;
  }
  return undefined;
}

export function accountIdFromIdToken(idToken: string | undefined): string | undefined {
  if (!idToken) return undefined;
  return extractAccountIdFromClaims(jwtClaims(idToken));
}

export function extractResidency(token: string): string | undefined {
  const claims = jwtClaims(token);
  if (!claims) return undefined;
  const auth = asRecord(claims["https://api.openai.com/auth"]);
  const residency =
    (typeof auth?.chatgpt_compute_residency === "string" ? auth.chatgpt_compute_residency : undefined) ??
    (typeof claims.chatgpt_compute_residency === "string" ? claims.chatgpt_compute_residency : undefined);
  if (!residency || residency === "no_constraint") return undefined;
  return residency;
}

export function expiresAtFromAccessToken(accessToken: string): number | undefined {
  const exp = jwtClaims(accessToken)?.exp;
  return typeof exp === "number" && exp > 0 ? exp * 1000 : undefined;
}

export function codexKeyFromAccessToken(accessToken: string): string | undefined {
  const token = accessToken.trim();
  if (!token || token.includes("\n")) return undefined;
  const accountId = accountIdFromIdToken(token);
  if (!accountId) return undefined;
  return encodeCodexKey({
    accessToken: token,
    accountId,
    expiresAt: expiresAtFromAccessToken(token),
    residency: extractResidency(token),
  });
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
  if (!accessToken) throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token response missing access_token`);
  const refreshToken =
    typeof json.refresh_token === "string" && json.refresh_token
      ? json.refresh_token
      : fallback?.refreshToken;
  const idToken = typeof json.id_token === "string" ? json.id_token : undefined;
  const accountId =
    accountIdFromIdToken(idToken) ??
    extractAccountIdFromClaims(jwtClaims(accessToken)) ??
    fallback?.accountId;
  if (!accountId) throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token response missing ChatGPT account id`);
  const expiresAt = expiresAtFromAccessToken(accessToken) ?? fallback?.expiresAt;
  const residency = extractResidency(accessToken) ?? (idToken ? extractResidency(idToken) : undefined) ?? fallback?.residency;
  return {
    accessToken,
    accountId,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(residency ? { residency } : {}),
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
    throw new Error(`Invalid ${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} device authorization response`);
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
    throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token exchange failed (${tokenError(result.json, result.status)})`);
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
        throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} device authorization returned no code`);
      }
      return exchangeDeviceCode(code, verifier);
    }
    if (response.status === 403 || response.status === 404) {
      await sleep(interval);
      continue;
    }
    throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} device authorization failed (HTTP ${response.status})`);
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
    throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token refresh failed (${tokenError(result.json, result.status)})`);
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

export const CODEX_OAUTH_PORT = 1455;
export const CODEX_OAUTH_FALLBACK_PORT = 1457;

export function buildCodexAuthorizeUrl(redirectUri: string, pkce: { challenge: string }, state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CODEX_SCOPE,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  });
  return `${CODEX_AUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
}

export async function exchangeCodexAuthCode(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<CodexCredential> {
  const response = await fetch(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: CODEX_CLIENT_ID,
      code_verifier: codeVerifier,
    }).toString(),
    signal: AbortSignal.timeout(30_000),
  });
  const json = asRecord(await response.json().catch(() => ({}))) ?? {};
  if (!response.ok) {
    throw new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} token exchange failed (${tokenError(json, response.status)})`);
  }
  return credentialFromTokens(json, undefined);
}

export interface CodexBrowserAuthHandle {
  readonly url: string;
  waitForCredential(): Promise<CodexCredential>;
  close(): void;
}

export async function startCodexBrowserAuth(): Promise<CodexBrowserAuthHandle> {
  const { createPkcePair, randomState } = await import("../mcp/auth/pkce.js");
  const { createServer } = await import("node:http");
  const pkce = createPkcePair();
  const state = randomState();

  let settlePromise: { resolve: (cred: CodexCredential) => void; reject: (err: Error) => void } = {
    resolve: () => undefined,
    reject: () => undefined,
  };
  const promise = new Promise<CodexCredential>((resolve, reject) => {
    settlePromise = { resolve, reject };
  });

  let settled = false;
  const succeed = (cred: CodexCredential) => {
    if (settled) return;
    settled = true;
    settlePromise.resolve(cred);
  };
  const fail = (err: Error) => {
    if (settled) return;
    settled = true;
    settlePromise.reject(err);
  };

  let exchange: (code: string) => Promise<CodexCredential> = () =>
    Promise.reject(new Error("Codex callback server not ready"));
  const server = createServer((req, res) => {
    const parsed = new URL(req.url || "/", "http://localhost");
    if (parsed.pathname === "/auth/callback") {
      const error = parsed.searchParams.get("error");
      const errorDescription = parsed.searchParams.get("error_description");
      if (error) {
        const msg = errorDescription || error;
        fail(new Error(msg));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee"><h1 style="color:#ff453a">Authorization Failed</h1><p>${msg}</p></body></html>`);
        return;
      }
      const code = parsed.searchParams.get("code");
      const returnedState = parsed.searchParams.get("state");
      if (!code || returnedState !== state) {
        fail(new Error("Invalid authorization callback state or missing code"));
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee"><h1 style="color:#ff453a">Invalid State</h1><p>CSRF verification failed.</p></body></html>`);
        return;
      }
      exchange(code)
        .then((cred) => {
          succeed(cred);
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee"><h1 style="color:#30d158">✓ Authorization Successful</h1><p>You can close this tab and return to CLAI.</p><script>setTimeout(()=>window.close(),2500)</script></body></html>`);
        })
        .catch((err) => {
          fail(err instanceof Error ? err : new Error(String(err)));
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#111;color:#eee"><h1 style="color:#ff453a">Token Exchange Failed</h1><p>${err instanceof Error ? err.message : String(err)}</p></body></html>`);
        });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

  let port = CODEX_OAUTH_PORT;
  try {
    await listen(CODEX_OAUTH_PORT);
  } catch {
    port = CODEX_OAUTH_FALLBACK_PORT;
    await listen(CODEX_OAUTH_FALLBACK_PORT);
  }

  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authUrl = buildCodexAuthorizeUrl(redirectUri, pkce, state);
  exchange = (code: string) => exchangeCodexAuthCode(code, redirectUri, pkce.verifier);

  const cleanup = () => {
    try {
      server.close();
    } catch {}
  };

  const timer = setTimeout(() => {
    cleanup();
    fail(new Error(`${CHATGPT_SUBSCRIPTION_DISPLAY_NAME} authorization timed out after 5 minutes`));
  }, 5 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref();

  return {
    url: authUrl,
    async waitForCredential(): Promise<CodexCredential> {
      try {
        return await promise;
      } finally {
        clearTimeout(timer);
        cleanup();
      }
    },
    close(): void {
      clearTimeout(timer);
      cleanup();
    },
  };
}
