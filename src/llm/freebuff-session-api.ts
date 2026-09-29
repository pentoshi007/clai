import { randomUUID } from "node:crypto";
import { FREEBUFF_API_BASE_URL } from "./freebuff-auth.js";
import { ProviderError } from "./http.js";

export const FREEBUFF_CLI_CLAIM_PREFIX = "cli:";
export const FREEBUFF_SESSION_PATH = "/api/v1/freebuff/session";
export const FREEBUFF_SESSION_ADMISSION_PATH = "/api/v1/freebuff/session/admission";
export const FREEBUFF_HEARTBEAT_INTERVAL_MS = 45_000;
const SESSION_FETCH_TIMEOUT_MS = 20_000;

const HEADER = {
  timezone: "x-fb-timezone",
  firstTabDiscount: "x-freebuff-first-tab-discount",
  multiSession: "x-freebuff-multi-session",
  purchaseContinuity: "x-freebuff-purchase-continuity",
  desktopAttempt: "x-freebuff-desktop-attempt-id",
  instance: "x-freebuff-instance-id",
  heartbeat: "x-freebuff-heartbeat",
  includeUnusedRateLimits: "x-freebuff-include-unused-rate-limits",
  compactSession: "x-freebuff-compact-session",
  model: "x-freebuff-model",
  walletSpendLimit: "x-freebuff-wallet-spend-limit",
  takeoverInstance: "x-freebuff-takeover-instance-id",
} as const;

export type FreebuffSessionMethod = "GET" | "POST" | "DELETE";

export interface FreebuffWalletConsent {
  readonly price: number;
  readonly walletSpend: number;
}

export type FreebuffSessionResponse =
  | {
      status: "active";
      instanceId: string;
      model: string;
      admittedAt?: string;
      expiresAt?: string;
      remainingMs?: number;
    }
  | { status: "none"; message?: string }
  | { status: "ended"; instanceId?: string; expiresAt?: string }
  | { status: "superseded" }
  | { status: "consent_required"; walletConsent: FreebuffWalletConsent }
  | { status: "first_tab_discount_changed" }
  | { status: "model_locked"; currentModel: string; requestedModel: string }
  | {
      status: "model_unavailable";
      requestedModel: string;
      availableHours?: string;
      requiresSubscription?: boolean;
      withdrawn?: boolean;
    }
  | { status: "rate_limited"; model?: string; retryAfterMs?: number; message?: string }
  | { status: "spend_limited"; message?: string; resetAt?: string; retryAfterMs?: number }
  | { status: "ip_capped"; model?: string; limit?: number; retryAfterMs?: number }
  | { status: "premium_slot_taken"; requestedModel?: string; currentModel?: string }
  | { status: "purchase_in_use" | "purchase_capacity"; requestedModel?: string }
  | { status: "purchase_claim_released" }
  | { status: "country_blocked"; countryCode?: string; message?: string }
  | { status: "banned"; message?: string };

export class FreebuffSessionRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryAfterMs?: number | undefined,
    readonly errorCode?: string | undefined,
  ) {
    super(message);
    this.name = "FreebuffSessionRequestError";
  }
}

export function newFreebuffCliInstanceId(): string {
  return `${FREEBUFF_CLI_CLAIM_PREFIX}${randomUUID()}`;
}

export function freebuffCliAttemptId(instanceId: string | undefined): string | undefined {
  return instanceId?.startsWith(FREEBUFF_CLI_CLAIM_PREFIX)
    ? instanceId.slice(FREEBUFF_CLI_CLAIM_PREFIX.length)
    : undefined;
}

export function freebuffSessionMetadata(instanceId: string): Record<string, string> {
  const attemptId = freebuffCliAttemptId(instanceId);
  return {
    freebuff_instance_id: instanceId,
    ...(attemptId ? { freebuff_multi_session: "1", surface: "cli" } : {}),
  };
}

function timezoneHeader(): Record<string, string> {
  try {
    return { [HEADER.timezone]: Intl.DateTimeFormat().resolvedOptions().timeZone };
  } catch {
    return {};
  }
}

function sessionFetchSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(SESSION_FETCH_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

export interface FreebuffSessionCallOptions {
  readonly instanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly walletSpendLimit?: number | undefined;
  readonly compact?: boolean | undefined;
  readonly heartbeat?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof fetch | undefined;
}

function admissionHeaders(
  method: FreebuffSessionMethod,
  token: string,
  opts: FreebuffSessionCallOptions,
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    ...timezoneHeader(),
    [HEADER.firstTabDiscount]: "0",
  };
  const attemptId = freebuffCliAttemptId(opts.instanceId);
  const multiSession = Boolean(attemptId);
  if (multiSession) {
    headers[HEADER.multiSession] = "1";
    headers[HEADER.purchaseContinuity] = "1";
    if (attemptId && method !== "GET") headers[HEADER.desktopAttempt] = attemptId;
    if (method === "GET" && opts.instanceId && opts.heartbeat) {
      headers[HEADER.heartbeat] = "1";
      if (!opts.compact) headers[HEADER.includeUnusedRateLimits] = "1";
    }
  }
  if ((multiSession || method !== "POST") && opts.instanceId) {
    headers[HEADER.instance] = opts.instanceId;
  }
  if (method === "GET" && opts.compact) headers[HEADER.compactSession] = "1";
  if (method === "POST") {
    if (opts.model) headers[HEADER.model] = opts.model;
    headers[HEADER.walletSpendLimit] = String(opts.walletSpendLimit ?? 0);
  }
  return headers;
}

function endpointFor(
  method: FreebuffSessionMethod,
  base: string,
  instanceId: string | undefined,
): string {
  const root = base.replace(/\/$/, "");
  if (method === "POST") return `${root}${FREEBUFF_SESSION_ADMISSION_PATH}`;
  if (method === "DELETE" && freebuffCliAttemptId(instanceId)) {
    return `${root}${FREEBUFF_SESSION_PATH}/attempt`;
  }
  return `${root}${FREEBUFF_SESSION_PATH}`;
}

const typedRefusalStatuses = new Set([
  "country_blocked",
  "banned",
  "model_locked",
  "model_unavailable",
  "premium_slot_taken",
  "purchase_in_use",
  "purchase_capacity",
  "purchase_claim_released",
  "first_tab_discount_changed",
  "consent_required",
  "rate_limited",
  "spend_limited",
  "ip_capped",
]);

export async function callFreebuffSession(
  method: FreebuffSessionMethod,
  token: string,
  opts: FreebuffSessionCallOptions = {},
): Promise<FreebuffSessionResponse> {
  const fetchImpl = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? FREEBUFF_API_BASE_URL;
  const response = await fetchImpl(endpointFor(method, base, opts.instanceId), {
    method,
    headers: admissionHeaders(method, token, opts),
    signal: sessionFetchSignal(opts.signal),
  });
  if (method === "POST" && (response.status === 404 || response.status === 405)) {
    throw new FreebuffSessionRequestError(
      "Freebuff session admission is unavailable on this server.",
      response.status,
      undefined,
      "session_admission_unsupported",
    );
  }
  if (response.status === 404) return { status: "none" };
  const parsed = (await response
    .json()
    .catch(() => null)) as FreebuffSessionResponse | null;
  if (
    parsed &&
    typeof parsed.status === "string" &&
    (response.ok || typedRefusalStatuses.has(parsed.status))
  ) {
    return parsed;
  }
  if (!response.ok) {
    throw new FreebuffSessionRequestError(
      `Freebuff session ${method} failed (${response.status}).`,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      typeof (parsed as unknown as { error?: unknown })?.error === "string"
        ? (parsed as unknown as { error: string }).error
        : undefined,
    );
  }
  throw new ProviderError(`Freebuff session ${method} returned an unrecognized response.`);
}
