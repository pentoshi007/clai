import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";

export const KIRO_DEFAULT_REGION = "us-east-1";
export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
export const KIRO_START_URL = "https://view.awsapps.com/start";
export const KIRO_REDIRECT_URI = "kiro://kiro.kiroAgent/authenticate-success";
export const KIRO_KEY_PREFIX = "kiro:";

export const KIRO_CLI_PORTAL_URL = "https://app.kiro.dev/signin";
export const KIRO_CLI_REDIRECT_URI = "http://localhost:3128";
export const KIRO_CLI_REDIRECT_FROM = "kirocli";
export const KIRO_CLI_CALLBACK_PORT = 3128;
export const KIRO_CLI_CALLBACK_PATH = "/oauth/callback";
export const KIRO_CLI_SIGNIN_CALLBACK_PATH = "/signin/callback";
export const KIRO_DESKTOP_UA_VERSION = "0.7.45";

export const AWS_REGION_PATTERN = /^[a-z]{2}-[a-z]+-\d{1,2}$/;

export function assertValidAwsRegion(region?: string): string {
  const value = (region ?? KIRO_DEFAULT_REGION).trim().toLowerCase();
  if (!AWS_REGION_PATTERN.test(value)) {
    throw new Error(`Invalid AWS region: "${value}"`);
  }
  return value;
}

export type KiroAuthMethod =
  | "builder-id"
  | "idc"
  | "google"
  | "github"
  | "imported"
  | "api_key"
  | "external_idp";

export interface KiroCredential {
  accessToken: string;
  refreshToken?: string | undefined;
  profileArn?: string | undefined;
  expiresAt?: number | undefined;
  authMethod?: KiroAuthMethod | undefined;
  region?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  startUrl?: string | undefined;
  apiKey?: string | undefined;
}

export interface KiroDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string | undefined;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
  clientId: string;
  clientSecret: string;
  region: string;
  startUrl: string;
  authMethod: "builder-id" | "idc";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sha256Base64Url(str: string): string {
  return base64UrlEncode(createHash("sha256").update(str, "utf8").digest());
}

export function isKiroOAuthToken(value: string): boolean {
  return value.startsWith(KIRO_KEY_PREFIX);
}

export function isKiroRefreshToken(value: string): boolean {
  return value.trim().startsWith("aorAAAAAG");
}

export function encodeKiroKey(credential: KiroCredential): string {
  const payload = {
    a: credential.accessToken,
    r: credential.refreshToken ?? "",
    p: credential.profileArn ?? "",
    e: credential.expiresAt ?? 0,
    m: credential.authMethod ?? "builder-id",
    g: credential.region ?? KIRO_DEFAULT_REGION,
    c: credential.clientId ?? "",
    s: credential.clientSecret ?? "",
    u: credential.startUrl ?? "",
    k: credential.apiKey ?? "",
  };
  return (
    KIRO_KEY_PREFIX +
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  );
}

export function decodeKiroKey(value: string): KiroCredential | undefined {
  if (!isKiroOAuthToken(value)) return undefined;
  try {
    const raw = Buffer.from(
      value.slice(KIRO_KEY_PREFIX.length),
      "base64url",
    ).toString("utf8");
    const json = JSON.parse(raw) as {
      a?: unknown;
      r?: unknown;
      p?: unknown;
      e?: unknown;
      m?: unknown;
      g?: unknown;
      c?: unknown;
      s?: unknown;
      u?: unknown;
      k?: unknown;
    };
    if (typeof json?.a !== "string" && typeof json?.k !== "string") return undefined;
    return {
      accessToken: typeof json?.a === "string" ? json.a : "",
      refreshToken: typeof json?.r === "string" && json.r ? json.r : undefined,
      profileArn: typeof json?.p === "string" && json.p ? json.p : undefined,
      expiresAt: typeof json?.e === "number" && json.e > 0 ? json.e : undefined,
      authMethod:
        typeof json?.m === "string" ? (json.m as KiroAuthMethod) : undefined,
      region: typeof json?.g === "string" && json.g ? json.g : KIRO_DEFAULT_REGION,
      clientId: typeof json?.c === "string" && json.c ? json.c : undefined,
      clientSecret: typeof json?.s === "string" && json.s ? json.s : undefined,
      startUrl: typeof json?.u === "string" && json.u ? json.u : undefined,
      apiKey: typeof json?.k === "string" && json.k ? json.k : undefined,
    };
  } catch {
    return undefined;
  }
}

export async function registerOidcClient(
  region = KIRO_DEFAULT_REGION,
  issuerUrl = KIRO_START_URL,
): Promise<{
  clientId: string;
  clientSecret: string;
  clientSecretExpiresAt?: number | undefined;
}> {
  const safeRegion = assertValidAwsRegion(region);
  const endpoint = `https://oidc.${safeRegion}.amazonaws.com/client/register`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      clientName: "kiro-cli",
      clientType: "public",
      scopes: [
        "codewhisperer:conversations",
        "codewhisperer:analysis",
        "codewhisperer:completions",
      ],
      grantTypes: [
        "urn:ietf:params:oauth:grant-type:device_code",
        "refresh_token",
      ],
      issuerUrl,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to register OIDC client (${response.status}): ${errorText}`);
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const clientId = typeof json?.clientId === "string" ? json.clientId : "";
  const clientSecret =
    typeof json?.clientSecret === "string" ? json.clientSecret : "";
  if (!clientId || !clientSecret) {
    throw new Error("Invalid OIDC client registration response");
  }

  const clientSecretExpiresAt =
    typeof json?.clientSecretExpiresAt === "number"
      ? json.clientSecretExpiresAt
      : undefined;

  return { clientId, clientSecret, clientSecretExpiresAt };
}

export async function startKiroDeviceAuth(
  options: {
    region?: string | undefined;
    startUrl?: string | undefined;
    authMethod?: "builder-id" | "idc" | undefined;
  } = {},
): Promise<KiroDeviceAuthStart> {
  const region = assertValidAwsRegion(options.region);
  const authMethod = options.authMethod ?? "builder-id";
  const startUrl = options.startUrl?.trim() || KIRO_START_URL;
  const client = await registerOidcClient(region, startUrl);

  const endpoint = `https://oidc.${region}.amazonaws.com/device_authorization`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      startUrl,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to start Kiro device authorization (${response.status}): ${errorText}`,
    );
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const deviceCode =
    typeof json?.deviceCode === "string" ? json.deviceCode : "";
  const userCode = typeof json?.userCode === "string" ? json.userCode : "";
  const verificationUri =
    typeof json?.verificationUri === "string" ? json.verificationUri : "";
  const verificationUriComplete =
    typeof json?.verificationUriComplete === "string"
      ? json.verificationUriComplete
      : undefined;

  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error("Invalid Kiro device authorization response");
  }

  const expiresInSeconds =
    typeof json?.expiresIn === "number" ? json.expiresIn : 600;
  const pollIntervalSeconds =
    typeof json?.interval === "number" ? Math.max(1, json.interval) : 5;

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresInSeconds,
    pollIntervalSeconds,
    clientId: client.clientId,
    clientSecret: client.clientSecret,
    region,
    startUrl,
    authMethod,
  };
}

export async function pollKiroDeviceAuth(
  start: KiroDeviceAuthStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
  } = {},
): Promise<KiroCredential> {
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  let interval = start.pollIntervalSeconds * 1000;
  const endpoint = `https://oidc.${start.region}.amazonaws.com/token`;

  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("Kiro authentication cancelled");
    }

    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      throw new Error("Kiro authentication code expired — start again");
    }

    options.onPending?.(remaining);

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId: start.clientId,
        clientSecret: start.clientSecret,
        deviceCode: start.deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const json = asRecord(await response.json().catch(() => ({})));

    if (response.ok && typeof json?.accessToken === "string") {
      const accessToken = json.accessToken;
      const refreshToken =
        typeof json?.refreshToken === "string" ? json.refreshToken : undefined;
      const expiresIn =
        typeof json?.expiresIn === "number" ? json.expiresIn : 3600;
      const expiresAt = Date.now() + expiresIn * 1000;

      let profileArn: string | undefined;
      try {
        profileArn = await listAvailableProfiles(accessToken, start.region);
      } catch {
        profileArn = undefined;
      }

      return {
        accessToken,
        refreshToken,
        profileArn,
        expiresAt,
        authMethod: start.authMethod,
        region: start.region,
        clientId: start.clientId,
        clientSecret: start.clientSecret,
        startUrl: start.startUrl,
      };
    }

    const error =
      typeof json?.error === "string" ? json.error : String(response.status);

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
          ? "Kiro authentication was denied"
          : "Kiro authentication code expired — start again",
      );
    }

    const description =
      typeof json?.error_description === "string" ? json.error_description : "";
    throw new Error(
      `Kiro authentication failed (${response.status})${description ? `: ${description}` : ""}`,
    );
  }
}

export async function startKiroSocialAuth(
  provider: "google" | "github",
): Promise<{ url: string; codeVerifier: string; state: string }> {
  const idp = provider === "google" ? "Google" : "Github";
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = base64UrlEncode(randomBytes(16));

  const params = new URLSearchParams({
    idp,
    redirect_uri: KIRO_REDIRECT_URI,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account",
  });

  const url = `${KIRO_AUTH_SERVICE}/login?${params.toString()}`;
  return { url, codeVerifier, state };
}

export async function exchangeKiroSocialCode(
  codeOrUrl: string,
  codeVerifier: string,
  provider: "google" | "github" = "google",
): Promise<KiroCredential> {
  let code = codeOrUrl.trim().replace(/^['"]|['"]$/g, "");
  if (code.includes("error=")) {
    try {
      const parsedUrl = new URL(code);
      const desc = parsedUrl.searchParams.get("error_description") || parsedUrl.searchParams.get("error");
      if (desc) throw new Error(desc);
    } catch (e) {
      if (e instanceof Error && !e.message.includes("Invalid URL")) throw e;
    }
    const errorMatch = /[?&]error=([^&#\s]+)/.exec(code);
    const descMatch = /[?&]error_description=([^&#\s]+)/.exec(code);
    const err = errorMatch?.[1] ? decodeURIComponent(errorMatch[1].replace(/\+/g, " ")) : "authentication_failed";
    const desc = descMatch?.[1] ? decodeURIComponent(descMatch[1].replace(/\+/g, " ")) : err;
    throw new Error(desc);
  }
  if (code.includes("code=")) {
    try {
      const parsedUrl = new URL(code);
      const c = parsedUrl.searchParams.get("code");
      if (c) code = c.trim();
    } catch {
      const match = /[?&]code=([^&#\s]+)/.exec(code);
      if (match?.[1]) {
        code = decodeURIComponent(match[1]).trim();
      } else {
        const direct = /^code=([^&#\s]+)/.exec(code);
        if (direct?.[1]) code = decodeURIComponent(direct[1]).trim();
      }
    }
  }

  const endpoint = `${KIRO_AUTH_SERVICE}/oauth/token`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": kiroDesktopUserAgent(),
    },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: KIRO_REDIRECT_URI,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kiro social token exchange failed (${response.status}): ${errorText}`);
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const accessToken =
    typeof json?.accessToken === "string" ? json.accessToken : "";
  if (!accessToken) {
    throw new Error("Invalid token response from Kiro auth service");
  }

  const refreshToken =
    typeof json?.refreshToken === "string" ? json.refreshToken : undefined;
  const profileArn =
    typeof json?.profileArn === "string" ? json.profileArn : undefined;
  const expiresIn = typeof json?.expiresIn === "number" ? json.expiresIn : 3600;

  return {
    accessToken,
    refreshToken,
    profileArn,
    expiresAt: Date.now() + expiresIn * 1000,
    authMethod: provider,
    region: KIRO_DEFAULT_REGION,
  };
}

export interface KiroSocialCallbackHandle {
  readonly port: number;
  close(): void;
}

export async function listenForKiroSocialCallback(options: {
  onCode: (urlOrCode: string) => void;
  signal?: AbortSignal | undefined;
}): Promise<KiroSocialCallbackHandle> {
  const { createServer } = await import("node:http");
  const { writeFile, unlink, mkdir } = await import("node:fs/promises");
  const home = homedir();
  const claiDir = join(home, ".clai");
  await mkdir(claiDir, { recursive: true }).catch(() => {});
  const portFile = join(claiDir, "kiro-pending-callback.json");

  let closed = false;
  const server = createServer((req, res) => {
    const host = req.headers.host || "127.0.0.1";
    const parsed = new URL(req.url || "/", `http://${host}`);
    if (parsed.pathname === "/callback" || parsed.pathname === "/kiro-callback") {
      const urlParam = parsed.searchParams.get("url") || parsed.searchParams.get("code");
      if (urlParam) {
        options.onCode(urlParam);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;padding:32px;background:#27272a;border-radius:12px;border:1px solid #3f3f46;box-shadow:0 10px 25px rgba(0,0,0,0.5);max-width:400px;"><h2 style="color:#22c55e;margin-top:0;">Kiro AI Authenticated</h2><p style="color:#a1a1aa;line-height:1.5;">You can close this tab and return to clai.</p></div></body></html>`,
        );
        return;
      }
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  await writeFile(
    portFile,
    JSON.stringify({ port, pid: process.pid, createdAt: Date.now() }),
    "utf8",
  ).catch(() => {});

  if (platform() === "linux") {
    try {
      await ensureLinuxSchemeHandler();
    } catch {}
  }

  const close = () => {
    if (closed) return;
    closed = true;
    server.close();
    unlink(portFile).catch(() => {});
  };

  if (options.signal) {
    options.signal.addEventListener("abort", close, { once: true });
  }

  return { port, close };
}

async function ensureLinuxSchemeHandler(): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const home = homedir();
  const binDir = join(home, ".local", "bin");
  const appDir = join(home, ".local", "share", "applications");
  await mkdir(binDir, { recursive: true }).catch(() => {});
  await mkdir(appDir, { recursive: true }).catch(() => {});

  const scriptPath = join(binDir, "clai-kiro-auth");
  const desktopPath = join(appDir, "kiro-scheme-handler.desktop");

  const scriptContent = [
    "#!/bin/sh",
    'FILE="$HOME/.clai/kiro-pending-callback.json"',
    'if [ -f "$FILE" ]; then',
    '  PORT=$(grep -o \'"port":[0-9]*\' "$FILE" | cut -d: -f2)',
    '  if [ -n "$PORT" ]; then',
    '    ARG="$1"',
    '    node -e \'const http = require("node:http"); const u = new URL("http://127.0.0.1:" + process.argv[1] + "/callback?url=" + encodeURIComponent(process.argv[2])); http.get(u, () => process.exit(0)).on("error", () => process.exit(0));\' "$PORT" "$ARG" 2>/dev/null || curl -s -m 3 "http://127.0.0.1:${PORT}/callback?url=$(node -e \'console.log(encodeURIComponent(process.argv[1]))\' "$ARG" 2>/dev/null || echo "$ARG")" >/dev/null 2>&1',
    "  fi",
    "fi",
  ].join("\n") + "\n";

  await writeFile(scriptPath, scriptContent, { mode: 0o755 });

  const desktopContent = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Kiro Scheme Handler",
    `Exec=${scriptPath} %u`,
    "StartupNotify=false",
    "NoDisplay=true",
    "MimeType=x-scheme-handler/kiro;",
  ].join("\n") + "\n";

  await writeFile(desktopPath, desktopContent, "utf8");

  await new Promise<void>((resolve) => {
    execFile(
      "gio",
      ["mime", "x-scheme-handler/kiro", "kiro-scheme-handler.desktop"],
      () => resolve(),
    );
  }).catch(() => {});
}

function kiroMachineFingerprint(): string {
  const seed =
    process.env.USER || process.env.USERNAME || process.env.HOME || "clai";
  return createHash("sha256").update(seed, "utf8").digest("hex").slice(0, 16);
}

export function kiroDesktopUserAgent(): string {
  return `KiroIDE-${KIRO_DESKTOP_UA_VERSION}-${kiroMachineFingerprint()}`;
}

export function isHeadlessEnvironment(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_CLIENT || process.env.SSH_TTY) {
    return true;
  }
  if (platform() === "linux") {
    return !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  }
  return false;
}

export interface KiroCliAuthorizationFlow {
  authorizeUrl: string;
  codeVerifier: string;
  state: string;
}

export function createKiroCliAuthorizationFlow(): KiroCliAuthorizationFlow {
  const codeVerifier = base64UrlEncode(randomBytes(32));
  const codeChallenge = sha256Base64Url(codeVerifier);
  const state = randomBytes(16).toString("hex");

  const params = new URLSearchParams({
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    redirect_uri: KIRO_CLI_REDIRECT_URI,
    redirect_from: KIRO_CLI_REDIRECT_FROM,
  });

  return {
    authorizeUrl: `${KIRO_CLI_PORTAL_URL}?${params.toString()}`,
    codeVerifier,
    state,
  };
}

export interface KiroCliCallback {
  code: string;
  loginOption: string;
  state?: string | undefined;
  path: string;
}

export function parseKiroCliCallback(input: string): KiroCliCallback {
  const value = input.trim();
  if (!value) {
    throw new Error("missing Kiro callback URL");
  }

  let path = KIRO_CLI_CALLBACK_PATH;
  let query = value;

  const urlMatch = /^https?:\/\/[^/]+(\/[^?]*)?(\?.*)?$/i.exec(value);
  const bareHostMatch = /^(?:localhost|127\.0\.0\.1)(?::\d+)?(\/[^?]*)?(\?.*)?$/i.exec(
    value,
  );

  if (urlMatch) {
    path = urlMatch[1] || KIRO_CLI_CALLBACK_PATH;
    query = (urlMatch[2] || "").replace(/^\?/, "");
  } else if (bareHostMatch) {
    path = bareHostMatch[1] || KIRO_CLI_CALLBACK_PATH;
    query = (bareHostMatch[2] || "").replace(/^\?/, "");
  } else if (value.includes("?")) {
    const idx = value.indexOf("?");
    path = value.slice(0, idx) || KIRO_CLI_CALLBACK_PATH;
    query = value.slice(idx + 1);
  }

  const queryNoHash = query.split("#")[0] ?? "";
  const pairs = new URLSearchParams(queryNoHash);

  const error = pairs.get("error");
  if (error) {
    const desc = pairs.get("error_description") || error;
    throw new Error(`Kiro login failed: ${desc}`);
  }

  const code = pairs.get("code");
  if (!code) {
    throw new Error("missing Kiro authorization code");
  }

  const loginOption = pairs.get("login_option");
  if (!loginOption) {
    throw new Error("missing Kiro login_option");
  }

  const state = pairs.get("state") || undefined;

  return { code, loginOption, state, path };
}

export async function exchangeKiroPortalCode(
  callback: KiroCliCallback,
  codeVerifier: string,
): Promise<KiroCredential> {
  const redirectUri = `${KIRO_CLI_REDIRECT_URI}${callback.path}?login_option=${callback.loginOption}`;
  const endpoint = `${KIRO_AUTH_SERVICE}/oauth/token`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": kiroDesktopUserAgent(),
    },
    body: JSON.stringify({
      code: callback.code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
      invitation_code: null,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Kiro portal token exchange failed (${response.status}): ${errorText}`,
    );
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const accessToken =
    typeof json?.accessToken === "string" ? json.accessToken : "";
  if (!accessToken) {
    throw new Error("Invalid token response from Kiro auth service");
  }

  const refreshToken =
    typeof json?.refreshToken === "string" ? json.refreshToken : undefined;
  const profileArn =
    typeof json?.profileArn === "string" ? json.profileArn : undefined;
  const expiresIn = typeof json?.expiresIn === "number" ? json.expiresIn : 3600;

  return {
    accessToken,
    refreshToken,
    profileArn,
    expiresAt: Date.now() + expiresIn * 1000,
    authMethod: callback.loginOption === "google" || callback.loginOption === "github"
      ? callback.loginOption
      : "imported",
    region: KIRO_DEFAULT_REGION,
  };
}

export interface KiroCliCallbackServer {
  readonly port: number;
  readonly promise: Promise<KiroCliCallback>;
  close(): void;
}

export function listenForKiroCliCallback(options: {
  expectedState: string;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}): KiroCliCallbackServer {
  const timeoutMs = options.timeoutMs ?? 300_000;

  let resolvePromise!: (cb: KiroCliCallback) => void;
  let rejectPromise!: (err: Error) => void;
  const promise = new Promise<KiroCliCallback>((res, rej) => {
    resolvePromise = res;
    rejectPromise = rej;
  });

  let settled = false;
  let server: ReturnType<typeof createServer> | undefined;

  const finish = (err?: Error, cb?: KiroCliCallback): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    server?.close();
    if (err) rejectPromise(err);
    else if (cb) resolvePromise(cb);
  };

  const timer = setTimeout(() => {
    finish(new Error("Kiro login timed out waiting for browser callback"));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();

  server = createServer((req, res) => {
    const host = req.headers.host || `localhost:${KIRO_CLI_CALLBACK_PORT}`;
    let parsed: URL;
    try {
      parsed = new URL(req.url || "/", `http://${host}`);
    } catch {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("Bad request");
      return;
    }

    const pathname = parsed.pathname;
    if (
      pathname !== KIRO_CLI_CALLBACK_PATH &&
      pathname !== KIRO_CLI_SIGNIN_CALLBACK_PATH &&
      pathname !== "/"
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    const fullInput = `${pathname}${parsed.search}`;

    let callback: KiroCliCallback;
    try {
      callback = parseKiroCliCallback(fullInput);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;padding:32px;background:#27272a;border-radius:12px;border:1px solid #3f3f46;max-width:420px;"><h2 style="color:#ef4444;margin-top:0;">Kiro login failed</h2><p style="color:#a1a1aa;line-height:1.5;">${msg.replace(/</g, "&lt;")}</p><p style="color:#71717a;font-size:13px;">Return to clai and try again.</p></div></body></html>`,
      );
      finish(err instanceof Error ? err : new Error(msg));
      return;
    }

    if (options.expectedState && callback.state && callback.state !== options.expectedState) {
      const err = new Error(
        "Kiro login state mismatch (possible CSRF). Please try again.",
      );
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;padding:32px;background:#27272a;border-radius:12px;border:1px solid #3f3f46;max-width:420px;"><h2 style="color:#ef4444;margin-top:0;">Kiro login failed</h2><p style="color:#a1a1aa;line-height:1.5;">State mismatch. Return to clai and try again.</p></div></body></html>`,
      );
      finish(err);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;background:#18181b;color:#f4f4f5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;"><div style="text-align:center;padding:32px;background:#27272a;border-radius:12px;border:1px solid #3f3f46;max-width:420px;"><h2 style="color:#22c55e;margin-top:0;">Kiro AI Authenticated</h2><p style="color:#a1a1aa;line-height:1.5;">You can close this tab and return to clai.</p></div></body></html>`,
    );
    finish(undefined, callback);
  });

  server.once("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      finish(
        new Error(
          `Port ${KIRO_CLI_CALLBACK_PORT} is in use — close the other app or use device-code sign-in instead.`,
        ),
      );
    } else {
      finish(err);
    }
  });

  server.listen(KIRO_CLI_CALLBACK_PORT, "127.0.0.1");

  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => finish(new Error("Kiro authentication cancelled")),
      { once: true },
    );
  }

  return {
    port: KIRO_CLI_CALLBACK_PORT,
    promise,
    close() {
      finish(new Error("Kiro authentication cancelled"));
    },
  };
}

export async function refreshKiroToken(
  refreshToken: string,
  options: {
    clientId?: string | undefined;
    clientSecret?: string | undefined;
    region?: string | undefined;
    profileArn?: string | undefined;
    startUrl?: string | undefined;
    authMethod?: KiroAuthMethod | undefined;
  } = {},
): Promise<KiroCredential> {
  const { clientId, clientSecret, region } = options;

  if (clientId && clientSecret) {
    const safeRegion = assertValidAwsRegion(region);
    const endpoint = `https://oidc.${safeRegion}.amazonaws.com/token`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        refreshToken,
        grantType: "refresh_token",
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Kiro token refresh failed (${response.status}): ${errorText}`);
    }

    const json = asRecord(await response.json().catch(() => ({})));
    const accessToken =
      typeof json?.accessToken === "string" ? json.accessToken : "";
    if (!accessToken) {
      throw new Error("Invalid token refresh response from AWS OIDC");
    }

    const newRefreshToken =
      typeof json?.refreshToken === "string"
        ? json.refreshToken
        : refreshToken;
    const expiresIn =
      typeof json?.expiresIn === "number" ? json.expiresIn : 3600;

    let profileArn = options.profileArn;
    if (!profileArn) {
      try {
        profileArn = await listAvailableProfiles(accessToken, safeRegion);
      } catch {
        profileArn = undefined;
      }
    }

    return {
      accessToken,
      refreshToken: newRefreshToken,
      profileArn,
      expiresAt: Date.now() + expiresIn * 1000,
      authMethod: options.authMethod ?? "builder-id",
      region: safeRegion,
      clientId,
      clientSecret,
      startUrl: options.startUrl,
    };
  }

  const endpoint = `${KIRO_AUTH_SERVICE}/refreshToken`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": kiroDesktopUserAgent(),
    },
    body: JSON.stringify({ refreshToken }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Kiro token refresh failed (${response.status}): ${errorText}`);
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const accessToken =
    typeof json?.accessToken === "string" ? json.accessToken : "";
  if (!accessToken) {
    throw new Error("Invalid token refresh response from Kiro service");
  }

  const newRefreshToken =
    typeof json?.refreshToken === "string" ? json.refreshToken : refreshToken;
  const profileArn =
    typeof json?.profileArn === "string"
      ? json.profileArn
      : options.profileArn;
  const expiresIn = typeof json?.expiresIn === "number" ? json.expiresIn : 3600;

  return {
    accessToken,
    refreshToken: newRefreshToken,
    profileArn,
    expiresAt: Date.now() + expiresIn * 1000,
    authMethod: options.authMethod ?? "imported",
    region: options.region ?? KIRO_DEFAULT_REGION,
  };
}

export async function listAvailableProfiles(
  accessToken: string,
  region = KIRO_DEFAULT_REGION,
): Promise<string | undefined> {
  const safeRegion = assertValidAwsRegion(region);
  const endpoint = `https://codewhisperer.${safeRegion}.amazonaws.com`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.0",
      "x-amz-target": "AmazonCodeWhispererService.ListAvailableProfiles",
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
    body: JSON.stringify({ maxResults: 10 }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) return undefined;

  const json = asRecord(await response.json().catch(() => ({})));
  const profiles = Array.isArray(json?.profiles) ? json.profiles : [];

  const arnOf = (p: unknown): string | null => {
    const rec = asRecord(p);
    return typeof rec?.arn === "string"
      ? rec.arn
      : typeof rec?.profileArn === "string"
        ? rec.profileArn
        : null;
  };

  const match =
    profiles.find((p) => arnOf(p)?.split(":")[3] === safeRegion) ||
    profiles[0];
  return arnOf(match) ?? undefined;
}

export async function listAvailableApiKeyModels(
  apiKey: string,
  region = KIRO_DEFAULT_REGION,
): Promise<string[]> {
  const safeRegion = assertValidAwsRegion(region);
  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  const endpoint = `https://q.${safeRegion}.amazonaws.com/ListAvailableModels?${params.toString()}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      TokenType: "API_KEY",
      Accept: "application/json",
      "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
      "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
    },
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to list API key models (${response.status}): ${errorText}`);
  }

  const json = asRecord(await response.json().catch(() => ({})));
  const models = Array.isArray(json?.models) ? json.models : [];
  return models
    .map((m) => {
      const rec = asRecord(m);
      return typeof rec?.modelId === "string"
        ? rec.modelId
        : typeof rec?.id === "string"
          ? rec.id
          : "";
    })
    .filter(Boolean);
}

export async function validateKiroApiKey(
  apiKey: string,
  region = KIRO_DEFAULT_REGION,
): Promise<boolean> {
  try {
    const models = await listAvailableApiKeyModels(apiKey, region);
    return models.length > 0;
  } catch {
    return false;
  }
}

export async function candidateKiroCredentialPaths(): Promise<string[]> {
  const home = homedir();
  const os = platform();
  const paths: string[] = [
    join(home, ".kiro", "auth.json"),
    join(home, ".kiro", "credentials.json"),
  ];

  if (os === "darwin") {
    paths.push(
      join(home, "Library", "Application Support", "Kiro", "auth.json"),
      join(home, "Library", "Application Support", "kiro-desktop", "auth.json"),
    );
  } else if (os === "linux") {
    paths.push(
      join(home, ".config", "kiro", "auth.json"),
      join(home, ".config", "kiro-desktop", "auth.json"),
    );
  } else if (os === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    paths.push(
      join(appData, "Kiro", "auth.json"),
      join(appData, "kiro-desktop", "auth.json"),
    );
  }

  const ssoCacheDir = join(home, ".aws", "sso", "cache");
  try {
    const files = await readdir(ssoCacheDir);
    for (const file of files) {
      if (file.endsWith(".json")) {
        paths.push(join(ssoCacheDir, file));
      }
    }
  } catch {}

  return paths;
}

export async function readKiroStoredAuth(): Promise<KiroCredential | undefined> {
  const paths = await candidateKiroCredentialPaths();
  for (const path of paths) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const rec = asRecord(parsed);
    if (!rec) continue;

    const accessToken =
      typeof rec.accessToken === "string"
        ? rec.accessToken
        : typeof rec.access_token === "string"
          ? rec.access_token
          : "";
    const refreshToken =
      typeof rec.refreshToken === "string"
        ? rec.refreshToken
        : typeof rec.refresh_token === "string"
          ? rec.refresh_token
          : undefined;

    if (!accessToken && !refreshToken) continue;

    const clientId =
      typeof rec.clientId === "string"
        ? rec.clientId
        : typeof rec.client_id === "string"
          ? rec.client_id
          : undefined;
    const clientSecret =
      typeof rec.clientSecret === "string"
        ? rec.clientSecret
        : typeof rec.client_secret === "string"
          ? rec.client_secret
          : undefined;
    const region =
      typeof rec.region === "string" && rec.region
        ? rec.region
        : KIRO_DEFAULT_REGION;
    const profileArn =
      typeof rec.profileArn === "string"
        ? rec.profileArn
        : typeof rec.profile_arn === "string"
          ? rec.profile_arn
          : undefined;
    const startUrl =
      typeof rec.startUrl === "string"
        ? rec.startUrl
        : typeof rec.start_url === "string"
          ? rec.start_url
          : undefined;

    let expiresAt: number | undefined;
    if (typeof rec.expiresAt === "number") {
      expiresAt = rec.expiresAt;
    } else if (typeof rec.expires_at === "string") {
      expiresAt = Date.parse(rec.expires_at);
    }

    return {
      accessToken,
      refreshToken,
      profileArn,
      expiresAt,
      region,
      clientId,
      clientSecret,
      startUrl,
      authMethod: clientId && clientSecret ? "builder-id" : "imported",
    };
  }

  const home = homedir();
  const os = platform();
  const sqlitePaths: string[] = [
    join(home, ".local", "share", "kiro-cli", "data.sqlite3"),
    join(home, ".config", "kiro-cli", "data.sqlite3"),
    join(home, ".config", "kiro", "data.sqlite3"),
    join(home, ".kiro", "data.sqlite3"),
  ];
  if (os === "darwin") {
    sqlitePaths.push(
      join(home, "Library", "Application Support", "kiro-cli", "data.sqlite3"),
      join(home, "Library", "Application Support", "Kiro", "data.sqlite3"),
    );
  } else if (os === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    sqlitePaths.push(
      join(appData, "kiro-cli", "data.sqlite3"),
      join(appData, "Kiro", "data.sqlite3"),
    );
  }

  for (const dbPath of sqlitePaths) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT key, value FROM auth_kv").all() as { key: string; value: string }[];
        const byKey = new Map(rows.map((r) => [r.key, r.value]));

        const tokenKeys = [
          "kirocli:social:token",
          "kirocli:oidc:token",
          "kirocli:odic:token",
          "codewhisperer:oidc:token",
          "codewhisperer:odic:token",
        ];
        const deviceKeys = [
          "kirocli:oidc:device-registration",
          "kirocli:odic:device-registration",
          "codewhisperer:oidc:device-registration",
          "codewhisperer:odic:device-registration",
        ];

        const tokenRaw = tokenKeys.map((k) => byKey.get(k)).find((v) => v);
        if (!tokenRaw) continue;
        const deviceRaw = deviceKeys.map((k) => byKey.get(k)).find((v) => v);

        try {
          const parsed = JSON.parse(tokenRaw) as Record<string, unknown>;
          const device = deviceRaw
            ? (JSON.parse(deviceRaw) as Record<string, unknown>)
            : undefined;

          const accessToken =
            typeof parsed.access_token === "string"
              ? parsed.access_token
              : typeof parsed.accessToken === "string"
                ? parsed.accessToken
                : "";
          const refreshToken =
            typeof parsed.refresh_token === "string"
              ? parsed.refresh_token
              : typeof parsed.refreshToken === "string"
                ? parsed.refreshToken
                : undefined;
          if (!accessToken && !refreshToken) continue;

          let expiresAt: number | undefined;
          if (typeof parsed.expires_at === "number") expiresAt = parsed.expires_at;
          else if (typeof parsed.expiresAt === "number") expiresAt = parsed.expiresAt;
          else if (typeof parsed.expires_at === "string") expiresAt = Date.parse(parsed.expires_at);

          const profileArn =
            typeof parsed.profile_arn === "string"
              ? parsed.profile_arn
              : typeof parsed.profileArn === "string"
                ? parsed.profileArn
                : undefined;

          const clientId =
            (typeof parsed.clientId === "string" && parsed.clientId) ||
            (typeof parsed.client_id === "string" && parsed.client_id) ||
            (typeof device?.clientId === "string" && device.clientId) ||
            (typeof device?.client_id === "string" && device.client_id) ||
            undefined;
          const clientSecret =
            (typeof parsed.clientSecret === "string" && parsed.clientSecret) ||
            (typeof parsed.client_secret === "string" && parsed.client_secret) ||
            (typeof device?.clientSecret === "string" && device.clientSecret) ||
            (typeof device?.client_secret === "string" && device.client_secret) ||
            undefined;

          const provider =
            typeof parsed.provider === "string"
              ? parsed.provider.toLowerCase()
              : undefined;
          const authMethod: KiroAuthMethod =
            provider === "google" || provider === "github"
              ? provider
              : clientId && clientSecret
                ? "builder-id"
                : "imported";

          return {
            accessToken,
            refreshToken,
            expiresAt,
            profileArn,
            authMethod,
            region: KIRO_DEFAULT_REGION,
            clientId,
            clientSecret,
          };
        } catch {}
      } finally {
        db.close();
      }
    } catch {}
  }

  return undefined;
}

export async function importExistingKiroAuth(): Promise<KiroCredential | undefined> {
  const stored = await readKiroStoredAuth();
  if (!stored) return undefined;

  if (
    stored.refreshToken &&
    stored.expiresAt !== undefined &&
    stored.expiresAt < Date.now()
  ) {
    try {
      return await refreshKiroToken(stored.refreshToken, stored);
    } catch {
      return stored;
    }
  }

  return stored;
}

export async function maybeRefreshKiroCredential(
  key: string,
  storedRefreshToken?: string,
): Promise<string | undefined> {
  const decoded = decodeKiroKey(key);
  const refreshToken = decoded?.refreshToken || storedRefreshToken;
  if (!refreshToken) return undefined;

  try {
    const refreshed = await refreshKiroToken(refreshToken, decoded);
    return encodeKiroKey(refreshed);
  } catch {
    return undefined;
  }
}

export interface KiroModelInfo {
  readonly modelId: string;
  readonly modelName?: string | undefined;
  readonly description?: string | undefined;
  readonly rateMultiplier?: number | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly supportsImages?: boolean | undefined;
}

export interface KiroUsageBreakdown {
  readonly resourceType?: string | undefined;
  readonly displayName?: string | undefined;
  readonly displayNamePlural?: string | undefined;
  readonly unit?: string | undefined;
  readonly currency?: string | undefined;
  readonly currentUsage: number;
  readonly usageLimit: number;
  readonly currentOverages: number;
  readonly overageCap?: number | undefined;
  readonly overageRate?: number | undefined;
  readonly nextDateReset?: number | undefined;
}

export interface KiroUsageLimits {
  readonly subscriptionTitle?: string | undefined;
  readonly subscriptionType?: string | undefined;
  readonly overageStatus?: string | undefined;
  readonly nextDateReset?: number | undefined;
  readonly daysUntilReset?: number | undefined;
  readonly breakdowns: readonly KiroUsageBreakdown[];
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseModelInfo(value: unknown): KiroModelInfo | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const modelId =
    typeof rec.modelId === "string"
      ? rec.modelId
      : typeof rec.id === "string"
        ? rec.id
        : "";
  if (!modelId) return undefined;
  const tokenLimits = asRecord(rec.tokenLimits);
  const inputTypes = Array.isArray(rec.supportedInputTypes)
    ? rec.supportedInputTypes
    : undefined;
  return {
    modelId,
    modelName:
      typeof rec.modelName === "string" ? rec.modelName : undefined,
    description:
      typeof rec.description === "string" ? rec.description : undefined,
    rateMultiplier: optionalNumber(rec.rateMultiplier),
    maxInputTokens: tokenLimits ? optionalNumber(tokenLimits.maxInputTokens) : undefined,
    maxOutputTokens: tokenLimits ? optionalNumber(tokenLimits.maxOutputTokens) : undefined,
    supportsImages: inputTypes
      ? inputTypes.some((t) => typeof t === "string" && t.toUpperCase() === "IMAGE")
      : undefined,
  };
}

function kiroCatalogHeaders(credential: KiroCredential): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "AWS-SDK-JS/3.0.0 kiro-ide/1.0.0",
    "X-Amz-User-Agent": "aws-sdk-js/3.0.0 kiro-ide/1.0.0",
  };
  if (credential.authMethod === "api_key" && credential.apiKey) {
    headers["Authorization"] = `Bearer ${credential.apiKey}`;
    headers["TokenType"] = "API_KEY";
  } else if (credential.accessToken) {
    headers["Authorization"] = `Bearer ${credential.accessToken}`;
    if (credential.authMethod === "external_idp") {
      headers["TokenType"] = "EXTERNAL_IDP";
    }
  }
  return headers;
}

export async function listKiroModelsDetailed(
  credential: KiroCredential,
): Promise<KiroModelInfo[]> {
  const region = assertValidAwsRegion(credential.region);
  const params = new URLSearchParams({ origin: "AI_EDITOR" });
  const response = await fetch(
    `https://q.${region}.amazonaws.com/ListAvailableModels?${params.toString()}`,
    {
      method: "GET",
      headers: kiroCatalogHeaders(credential),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`ListAvailableModels failed (HTTP ${response.status})`);
  }
  const json = asRecord(await response.json().catch(() => ({})));
  const models = Array.isArray(json?.models) ? json.models : [];
  return models
    .map(parseModelInfo)
    .filter((info): info is KiroModelInfo => info !== undefined);
}

export async function getKiroUsageLimits(
  credential: KiroCredential,
): Promise<KiroUsageLimits> {
  const region = assertValidAwsRegion(credential.region);
  const body: Record<string, unknown> = {
    origin: "AI_EDITOR",
    resourceType: "AGENTIC_REQUEST",
    isEmailRequired: false,
  };
  if (credential.profileArn) body.profileArn = credential.profileArn;

  const headers: Record<string, string> = {
    "Content-Type": "application/x-amz-json-1.0",
    "x-amz-target": "AmazonCodeWhispererService.GetUsageLimits",
    Accept: "application/json",
    ...(credential.authMethod === "api_key" && credential.apiKey
      ? { Authorization: `Bearer ${credential.apiKey}`, TokenType: "API_KEY" }
      : { Authorization: `Bearer ${credential.accessToken}` }),
  };

  const endpoints = [
    `https://q.${region}.amazonaws.com/`,
    `https://codewhisperer.${region}.amazonaws.com/`,
    `https://runtime.${region}.kiro.dev/`,
  ];

  let lastError: Error | undefined;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        lastError = new Error(
          `GetUsageLimits failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
        );
        continue;
      }
      const json = asRecord(await response.json().catch(() => ({})));
      if (!json) {
        lastError = new Error("GetUsageLimits returned an invalid payload");
        continue;
      }
      const subscription = asRecord(json.subscriptionInfo);
      const overage = asRecord(json.overageConfiguration);
      const list = Array.isArray(json.usageBreakdownList)
        ? json.usageBreakdownList
        : [];
      const breakdowns: KiroUsageBreakdown[] = [];
      for (const entry of list) {
        const rec = asRecord(entry);
        if (!rec) continue;
        const used =
          optionalNumber(rec.currentUsageWithPrecision) ??
          optionalNumber(rec.currentUsage);
        const limit =
          optionalNumber(rec.usageLimitWithPrecision) ??
          optionalNumber(rec.usageLimit);
        if (used === undefined || limit === undefined) continue;
        breakdowns.push({
          resourceType:
            typeof rec.resourceType === "string" ? rec.resourceType : undefined,
          displayName:
            typeof rec.displayName === "string" ? rec.displayName : undefined,
          displayNamePlural:
            typeof rec.displayNamePlural === "string"
              ? rec.displayNamePlural
              : undefined,
          unit: typeof rec.unit === "string" ? rec.unit : undefined,
          currency:
            typeof rec.currency === "string" ? rec.currency : undefined,
          currentUsage: used,
          usageLimit: limit,
          currentOverages:
            optionalNumber(rec.currentOveragesWithPrecision) ??
            optionalNumber(rec.currentOverages) ??
            0,
          overageCap:
            optionalNumber(rec.overageCapWithPrecision) ??
            optionalNumber(rec.overageCap),
          overageRate: optionalNumber(rec.overageRate),
          nextDateReset: optionalNumber(rec.nextDateReset),
        });
      }
      return {
        subscriptionTitle:
          typeof subscription?.subscriptionTitle === "string"
            ? subscription.subscriptionTitle
            : undefined,
        subscriptionType:
          typeof subscription?.type === "string" ? subscription.type : undefined,
        overageStatus:
          typeof overage?.overageStatus === "string"
            ? overage.overageStatus
            : undefined,
        nextDateReset: optionalNumber(json.nextDateReset),
        daysUntilReset: optionalNumber(json.daysUntilReset),
        breakdowns,
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw lastError ?? new Error("GetUsageLimits failed on all Kiro endpoints");
}
