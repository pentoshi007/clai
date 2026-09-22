import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";

export const KIRO_DEFAULT_REGION = "us-east-1";
export const KIRO_AUTH_SERVICE = "https://prod.us-east-1.auth.desktop.kiro.dev";
export const KIRO_START_URL = "https://view.awsapps.com/start";
export const KIRO_REDIRECT_URI = "kiro://kiro.kiroAgent/authenticate-success";
export const KIRO_KEY_PREFIX = "kiro:";

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
        for (const row of rows) {
          if (!row.value) continue;
          try {
            const parsed = JSON.parse(row.value) as Record<string, unknown>;
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

            const provider =
              typeof parsed.provider === "string"
                ? parsed.provider.toLowerCase()
                : undefined;
            const authMethod =
              provider === "google" || provider === "github" ? provider : "imported";

            return {
              accessToken,
              refreshToken,
              expiresAt,
              profileArn,
              authMethod,
              region: KIRO_DEFAULT_REGION,
            };
          } catch {}
        }
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
