/**
 * Pure helpers for multi-API-key rotation within a single provider.
 *
 * Single key: many time-increasing retries (router owns the count).
 * Multiple keys: circular order from sticky start; 2 attempts per key.
 */

/** Max stored API keys per LLM provider (UI + save clamp). */
export const MAX_PROVIDER_KEYS = 10;

/** Attempts per key when multiple keys are configured (initial + one retry). */
export const MULTI_KEY_ATTEMPTS = 2;

/**
 * Circular attempt order of length `n` starting at `startIndex`.
 * Example: n=4, start=2 → [2, 3, 0, 1]
 */
export function buildKeyAttemptPlan(n: number, startIndex: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [0];
  const start = ((startIndex % n) + n) % n;
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    order.push((start + i) % n);
  }
  return order;
}

/**
 * How many attempts the router should make for one key slot.
 * Single-key mode uses the router's MAX_RETRIES budget (passed in).
 * Multi-key mode is always MULTI_KEY_ATTEMPTS.
 */
export function attemptsPerKey(keyCount: number, singleKeyMaxAttempts: number): number {
  if (keyCount <= 1) return Math.max(1, singleKeyMaxAttempts);
  return MULTI_KEY_ATTEMPTS;
}

function errorStatus(error: unknown): number {
  if (error && typeof error === "object" && "status" in error) {
    return (error as { status?: number }).status ?? 0;
  }
  return 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/** Auth failures: rotate to another key, but do not backoff-retry the same key. */
export function isAuthKeyError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403;
}

/**
 * Per-key billing / balance / quota failures (e.g. HTTP 402 insufficient credits).
 * These will not recover on the same key mid-request — rotate immediately.
 */
export function isQuotaKeyError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 402) return true;
  // Some gateways return 403/429 with credit wording; treat as quota when explicit.
  const msg = errorMessage(error);
  if (
    /insufficient credits|insufficient balance|out of credits|no credits|payment required|balance is 0|top up to continue|quota exceeded|billing/i.test(
      msg,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Failures that should move to the next key without sleeping on the same key
 * (auth revoked, empty wallet). Still try the rest of the circle.
 */
export function isImmediateKeySwitchError(error: unknown): boolean {
  return isAuthKeyError(error) || isQuotaKeyError(error);
}

/** Whether this error should rotate to the next API key (auth / capacity / transient). */
export function isKeyRotatableError(error: unknown, isRetriable: (e: unknown) => boolean): boolean {
  if (isRetriable(error)) return true;
  if (isImmediateKeySwitchError(error)) return true;
  // Empty / refused admissions sometimes vary by key or free-tier allotment.
  const msg = errorMessage(error);
  if (/no completion text|response was empty|empty response|returned no text/i.test(msg)) {
    return true;
  }
  return false;
}

/**
 * Model/request errors that will not improve with another key for the same
 * model. Outer provider fallback may still apply for some statuses (e.g. 413).
 */
export function isKeyCircleStopError(error: unknown): boolean {
  const status = errorStatus(error);
  // 404/422: wrong model or body — other keys won't help.
  // 413 is NOT here: same key circle is pointless, but another provider may work.
  // 402 is rotatable across keys, not a hard circle-stop.
  if (status === 404 || status === 422) return true;
  return false;
}

export type ProviderKeyEventType =
  | "using"
  | "retry"
  | "switch"
  | "endpoint"
  | "exhausted";

export interface ProviderKeyEvent {
  readonly type: ProviderKeyEventType;
  readonly provider: string;
  /** Last-4 style mask, e.g. `…ab12`. */
  readonly maskedTail: string;
  readonly reason?: string | undefined;
  readonly waitMs?: number | undefined;
  readonly keyIndex?: number | undefined;
  readonly keyCount?: number | undefined;
}

export function formatKeyEventStatus(event: ProviderKeyEvent): string {
  const keyPart = event.maskedTail ? ` ${event.maskedTail}` : "";
  const idx =
    event.keyIndex !== undefined && event.keyCount !== undefined && event.keyCount > 1
      ? ` [${event.keyIndex + 1}/${event.keyCount}]`
      : "";
  switch (event.type) {
    case "using":
      return `using ${event.provider}${idx}${keyPart}`;
    case "switch": {
      const why = event.reason ? ` (${event.reason})` : "";
      return `switching ${event.provider} key${idx}${keyPart}${why}`;
    }
    case "retry": {
      const secs =
        event.waitMs !== undefined ? ` in ${Math.ceil(event.waitMs / 1000)}s` : "";
      const why = event.reason ?? "retrying";
      return `⏳ ${event.provider}${idx}${keyPart} ${why}${secs}…`;
    }
    case "endpoint": {
      const why = event.reason ? ` (${event.reason})` : "";
      return `switching ${event.provider} endpoint${keyPart}${why}`;
    }
    case "exhausted":
      return `all ${event.provider} API keys failed`;
    default:
      return `${event.provider}${keyPart}`;
  }
}

const PROVIDER_FAILURE_SHAPE = /^(?:switching\b|⏳|all\s+\S+\s+API keys failed\b)/i;
const PROVIDER_FAILURE_REASON =
  /\b(?:rate limited|insufficient credits|auth failed|server error|connection glitch|quota|overloaded|unavailable|timed out|timeout)\b/i;

export function isProviderFailureStatus(text: string): boolean {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return false;
  return PROVIDER_FAILURE_SHAPE.test(line) || PROVIDER_FAILURE_REASON.test(line);
}
