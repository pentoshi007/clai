import { McpTransportError } from "../transport.js";
import { assertSafeDiscoveryUrl } from "./security.js";
import type { TokenResponse } from "./types.js";

export interface DeviceFlowDeps {
  readonly fetchImpl?: typeof fetch | undefined;
  readonly validateUrl?: ((url: string) => URL) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DeviceAuthorizationRequest {
  readonly deviceAuthorizationEndpoint: string;
  readonly clientId: string;
  readonly scope?: string | undefined;
}

export interface DeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string | undefined;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

export interface DeviceTokenPollRequest {
  readonly tokenEndpoint: string;
  readonly deviceCode: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly intervalSeconds: number;
  readonly expiresInSeconds: number;
}

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_SECONDS = 900;
const SLOW_DOWN_EXTRA_SECONDS = 5;
const MAX_POLL_INTERVAL_SECONDS = 60;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}

async function postForm(
  url: string,
  form: URLSearchParams,
  deps: DeviceFlowDeps,
): Promise<{ status: number; record: Record<string, unknown> | undefined }> {
  const validate = deps.validateUrl ?? assertSafeDiscoveryUrl;
  const target = validate(url);
  const impl = deps.fetchImpl ?? fetch;
  const response = await impl(target.toString(), {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: form.toString(),
    redirect: "manual",
  });
  const text = await response.text().catch(() => "");
  let record: Record<string, unknown> | undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      record = parsed as Record<string, unknown>;
    }
  } catch {
    record = undefined;
  }
  return { status: response.status, record };
}

export async function requestDeviceAuthorization(
  params: DeviceAuthorizationRequest,
  deps: DeviceFlowDeps = {},
): Promise<DeviceAuthorization> {
  const form = new URLSearchParams();
  form.set("client_id", params.clientId);
  if (params.scope) form.set("scope", params.scope);
  const { status, record } = await postForm(
    params.deviceAuthorizationEndpoint,
    form,
    deps,
  );
  const deviceCode = record?.device_code;
  const userCode = record?.user_code;
  const verificationUri =
    record?.verification_uri ?? record?.verification_url;
  if (
    status < 200 ||
    status >= 300 ||
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string"
  ) {
    const detail =
      typeof record?.error_description === "string"
        ? record.error_description
        : typeof record?.error === "string"
          ? record.error
          : `HTTP ${status}`;
    throw new McpTransportError(
      "protocol",
      `MCP OAuth device authorization request failed: ${detail.slice(0, 200)}.`,
    );
  }
  const complete = record?.verification_uri_complete;
  const interval = record?.interval;
  const expiresIn = record?.expires_in;
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof complete === "string" ? { verificationUriComplete: complete } : {}),
    intervalSeconds:
      typeof interval === "number" && interval > 0
        ? Math.min(interval, MAX_POLL_INTERVAL_SECONDS)
        : DEFAULT_INTERVAL_SECONDS,
    expiresInSeconds:
      typeof expiresIn === "number" && expiresIn > 0
        ? expiresIn
        : DEFAULT_EXPIRES_SECONDS,
  };
}

export async function pollDeviceTokens(
  params: DeviceTokenPollRequest,
  deps: DeviceFlowDeps = {},
): Promise<TokenResponse> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + params.expiresInSeconds * 1000;
  let intervalMs = Math.max(1, params.intervalSeconds) * 1000;
  for (;;) {
    if (Date.now() >= deadline) {
      throw new McpTransportError(
        "timeout",
        "MCP OAuth device authorization expired before sign-in completed.",
      );
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    const form = new URLSearchParams();
    form.set("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
    form.set("device_code", params.deviceCode);
    form.set("client_id", params.clientId);
    if (params.clientSecret !== undefined) {
      form.set("client_secret", params.clientSecret);
    }
    const { status, record } = await postForm(params.tokenEndpoint, form, deps);
    const accessToken = record?.access_token;
    if (status >= 200 && status < 300 && typeof accessToken === "string" && accessToken.length > 0) {
      return {
        accessToken,
        tokenType: typeof record?.token_type === "string" ? record.token_type : "Bearer",
        ...(typeof record?.expires_in === "number" ? { expiresIn: record.expires_in } : {}),
        ...(typeof record?.refresh_token === "string"
          ? { refreshToken: record.refresh_token }
          : {}),
        ...(typeof record?.scope === "string" ? { scope: record.scope } : {}),
      };
    }
    const error = typeof record?.error === "string" ? record.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalMs = Math.min(
        (intervalMs + SLOW_DOWN_EXTRA_SECONDS * 1000),
        MAX_POLL_INTERVAL_SECONDS * 1000,
      );
      continue;
    }
    if (error === "access_denied") {
      throw new McpTransportError(
        "protocol",
        "MCP OAuth device authorization was declined.",
      );
    }
    if (error === "expired_token") {
      throw new McpTransportError(
        "timeout",
        "MCP OAuth device code expired before sign-in completed.",
      );
    }
    const detail =
      typeof record?.error_description === "string"
        ? record.error_description
        : error || `HTTP ${status}`;
    throw new McpTransportError(
      "protocol",
      `MCP OAuth device token polling failed: ${detail.slice(0, 200)}.`,
    );
  }
}
