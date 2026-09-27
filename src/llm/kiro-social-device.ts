import {
  KIRO_AUTH_SERVICE,
  KIRO_DEFAULT_REGION,
  type KiroCredential,
} from "./kiro-auth.js";

export type KiroSocialProvider = "google" | "github";

export const KIRO_SOCIAL_DEVICE_CLIENT_ID = "kiro-cli";

export interface KiroSocialDeviceStart {
  readonly provider: KiroSocialProvider;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
  readonly pollIntervalSeconds: number;
}

type Fetch = typeof fetch;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveMs(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export async function startKiroSocialDeviceAuth(
  provider: KiroSocialProvider,
  fetchImpl: Fetch = fetch,
): Promise<KiroSocialDeviceStart> {
  const response = await fetchImpl(`${KIRO_AUTH_SERVICE}/oauth/device/authorization`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      clientId: KIRO_SOCIAL_DEVICE_CLIENT_ID,
      loginProvider: provider === "google" ? "Google" : "Github",
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const json = record(await response.json().catch(() => ({})));
  const deviceCode = text(json.deviceCode);
  const userCode = text(json.userCode);
  const verificationUri = text(json.verificationUri);
  if (!response.ok || !deviceCode || !userCode || !verificationUri) {
    throw new Error(`could not start Kiro ${provider} device sign-in (${response.status})`);
  }
  return {
    provider,
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: text(json.verificationUriComplete) || verificationUri,
    expiresInSeconds: Math.ceil(positiveMs(json.expiresInMilliseconds, 300_000) / 1000),
    pollIntervalSeconds: Math.ceil(positiveMs(json.intervalInMilliseconds, 5_000) / 1000),
  };
}

const TERMINAL_MESSAGES: Record<string, string> = {
  access_denied: "Kiro sign-in was denied",
  expired_token: "Kiro sign-in code expired — start again",
  invalid_token: "Kiro sign-in code is no longer valid — start again",
};

function waitFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Kiro authentication cancelled"));
    }, { once: true });
  });
}

export async function pollKiroSocialDeviceAuth(
  start: KiroSocialDeviceStart,
  options: {
    signal?: AbortSignal | undefined;
    onPending?: ((remainingSeconds: number) => void) | undefined;
    fetchImpl?: Fetch | undefined;
    wait?: ((ms: number, signal: AbortSignal | undefined) => Promise<void>) | undefined;
  } = {},
): Promise<KiroCredential> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? waitFor;
  const deadline = Date.now() + start.expiresInSeconds * 1000;
  let interval = start.pollIntervalSeconds * 1000;
  for (;;) {
    if (options.signal?.aborted) throw new Error("Kiro authentication cancelled");
    const remaining = Math.ceil((deadline - Date.now()) / 1000);
    if (remaining <= 0) throw new Error(TERMINAL_MESSAGES.expired_token);
    options.onPending?.(remaining);
    const response = await fetchImpl(`${KIRO_AUTH_SERVICE}/oauth/device/poll`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        deviceCode: start.deviceCode,
        clientId: KIRO_SOCIAL_DEVICE_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const json = record(await response.json().catch(() => ({})));
    const accessToken = text(json.accessToken);
    if (response.ok && accessToken) {
      const expiresIn = typeof json.expiresIn === "number" ? json.expiresIn : 3600;
      return {
        accessToken,
        ...(text(json.refreshToken) ? { refreshToken: text(json.refreshToken) } : {}),
        ...(text(json.profileArn) ? { profileArn: text(json.profileArn) } : {}),
        expiresAt: Date.now() + expiresIn * 1000,
        authMethod: start.provider,
        region: KIRO_DEFAULT_REGION,
      };
    }
    const status = text(json.error) || text(json.status) || String(response.status);
    if (status === "authorization_pending" || status === "slow_down") {
      if (status === "slow_down") interval += 5_000;
      await wait(interval, options.signal);
      continue;
    }
    throw new Error(TERMINAL_MESSAGES[status] ?? `Kiro sign-in failed (${status})`);
  }
}
