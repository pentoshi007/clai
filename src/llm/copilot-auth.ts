import { homedir, platform } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

export const COPILOT_API_BASE_URL = "https://api.githubcopilot.com";
export const COPILOT_GITHUB_API_BASE_URL = "https://api.github.com";
export const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const COPILOT_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_SCOPE = "read:user";
export const COPILOT_VERSION = "0.35.0";
export const COPILOT_EDITOR_VERSION = "vscode/1.107.0";

export const COPILOT_REQUEST_HEADERS: Record<string, string> = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": COPILOT_EDITOR_VERSION,
  "Editor-Plugin-Version": `copilot-chat/${COPILOT_VERSION}`,
  "User-Agent": `GitHubCopilotChat/${COPILOT_VERSION}`,
  "OpenAI-Intent": "conversation-panel",
  "OpenAI-Organization": "github-copilot",
  "X-GitHub-Api-Version": "2025-04-01",
  "X-VSCode-User-Agent-Library-Version": "electron-fetch",
};

export interface CopilotDeviceAuthStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface CopilotApiToken {
  token: string;
  baseUrl: string;
  expiresAt: number;
}

export function isCopilotOAuthToken(value: string): boolean {
  return value.startsWith("ghu_") || value.startsWith("github_pat_") || value.startsWith("gho_");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readJsonSafe(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text().catch(() => "");
  try {
    return asRecord(JSON.parse(body)) ?? {};
  } catch {
    const params = new URLSearchParams(body);
    return Object.fromEntries(params.entries());
  }
}

export async function startCopilotDeviceAuth(): Promise<CopilotDeviceAuthStart> {
  const response = await fetch(COPILOT_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: COPILOT_SCOPE,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await readJsonSafe(response);
  const deviceCode = typeof json.device_code === "string" ? json.device_code : "";
  const userCode = typeof json.user_code === "string" ? json.user_code : "";
  const verificationUri =
    typeof json.verification_uri_complete === "string"
      ? json.verification_uri_complete
      : typeof json.verification_uri === "string"
        ? json.verification_uri
        : "";
  if (!response.ok || !deviceCode || !userCode || !verificationUri) {
    throw new Error("Invalid GitHub device authorization response");
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 900;
  const interval = typeof json.interval === "number" ? json.interval : 5;
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

export async function pollCopilotDeviceAuth(
  start: CopilotDeviceAuthStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
  } = {},
): Promise<string> {
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  let interval = Math.max(1, start.pollIntervalSeconds) * 1000;
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("GitHub Copilot authentication cancelled");
    }
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (remaining <= 0) {
      throw new Error("GitHub Copilot authentication code expired — start again");
    }
    options.onPending?.(remaining);
    const response = await fetch(COPILOT_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: start.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await readJsonSafe(response);
    const accessToken =
      typeof json.access_token === "string" ? json.access_token : "";
    if (response.ok && accessToken) return accessToken;
    const error = typeof json.error === "string" ? json.error : "";
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
          ? "GitHub Copilot authentication was denied"
          : "GitHub Copilot authentication code expired — start again",
      );
    }
    const description =
      typeof json.error_description === "string" ? json.error_description : "";
    throw new Error(
      `GitHub Copilot authentication failed (${response.status})${description ? `: ${description}` : ""}`,
    );
  }
}

export async function fetchCopilotApiToken(
  githubToken: string,
): Promise<CopilotApiToken> {
  const response = await fetch(
    `${COPILOT_GITHUB_API_BASE_URL}/copilot_internal/v2/token`,
    {
      headers: {
        authorization: `token ${githubToken}`,
        accept: "application/json",
        "User-Agent": COPILOT_REQUEST_HEADERS["User-Agent"]!,
        "Editor-Version": COPILOT_REQUEST_HEADERS["Editor-Version"]!,
        "Editor-Plugin-Version": COPILOT_REQUEST_HEADERS["Editor-Plugin-Version"]!,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  const json = asRecord(await response.json().catch(() => ({})));
  const token = typeof json?.token === "string" ? json.token : "";
  if (!response.ok || !token) {
    const message =
      typeof json?.message === "string" ? json.message : `HTTP ${response.status}`;
    throw new Error(`GitHub Copilot token exchange failed: ${message}`);
  }
  const endpoints = asRecord(json?.endpoints);
  const baseUrl =
    typeof endpoints?.api === "string" && endpoints.api
      ? endpoints.api
      : COPILOT_API_BASE_URL;
  const expiresAt =
    typeof json?.expires_at === "number" && json.expires_at > 0
      ? json.expires_at * 1000
      : Date.now() + 25 * 60 * 1000;
  return { token, baseUrl, expiresAt };
}

const tokenCache = new Map<string, CopilotApiToken>();
const REFRESH_SKEW_MS = 60_000;

export async function resolveCopilotApiToken(
  githubToken: string,
): Promise<CopilotApiToken> {
  const cached = tokenCache.get(githubToken);
  if (cached && cached.expiresAt - REFRESH_SKEW_MS > Date.now()) return cached;
  const fresh = await fetchCopilotApiToken(githubToken);
  tokenCache.set(githubToken, fresh);
  return fresh;
}

export function invalidateCopilotApiToken(githubToken: string): void {
  tokenCache.delete(githubToken);
}

export function copilotRequestHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...COPILOT_REQUEST_HEADERS, "X-Request-Id": crypto.randomUUID(), ...extra };
}

export function copilotInitiator(
  messages: readonly { role?: string | undefined }[],
): "user" | "agent" {
  return messages.some(
    (message) => message.role === "assistant" || message.role === "tool",
  )
    ? "agent"
    : "user";
}

export async function verifyCopilotToken(githubToken: string): Promise<boolean> {
  try {
    const api = await resolveCopilotApiToken(githubToken);
    const response = await fetch(`${api.baseUrl}/models`, {
      headers: {
        authorization: `Bearer ${api.token}`,
        accept: "application/json",
        ...COPILOT_REQUEST_HEADERS,
      },
      signal: AbortSignal.timeout(15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function candidateCopilotCredentialPaths(): string[] {
  const home = homedir();
  const os = platform();
  const configHome =
    os === "win32"
      ? process.env.APPDATA ?? join(home, "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  const dir = join(configHome, "github-copilot");
  return [join(dir, "apps.json"), join(dir, "hosts.json")];
}

export function parseCopilotCredentialFile(parsed: unknown): string | undefined {
  const records = asRecord(parsed);
  if (!records) return undefined;
  let fallback: string | undefined;
  for (const value of Object.values(records)) {
    const entry = asRecord(value);
    if (!entry) continue;
    for (const field of [
      "oauth_token",
      "oauthToken",
      "token",
      "access_token",
      "accessToken",
    ]) {
      const candidate = entry[field];
      if (typeof candidate !== "string" || !candidate) continue;
      if (isCopilotOAuthToken(candidate)) return candidate;
      fallback ??= candidate;
    }
  }
  return fallback;
}

export async function importExistingCopilotKey(): Promise<string | undefined> {
  for (const path of candidateCopilotCredentialPaths()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    const token = parseCopilotCredentialFile(parsed);
    if (token && (await verifyCopilotToken(token))) return token;
  }
  return undefined;
}