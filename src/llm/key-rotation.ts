
import { mentionsQuotaExhaustion } from "./quota-signals.js";

export const MAX_PROVIDER_KEYS = 10;

export const MULTI_KEY_ATTEMPTS = 2;

export const RATE_LIMIT_RETRY_WAIT_MS: readonly number[] = [
  10_000, 20_000, 30_000, 40_000, 60_000,
];

export function rateLimitRetryWaitMs(
  attempt: number,
  maxMs = Number.POSITIVE_INFINITY,
): number {
  const index = Math.min(
    Math.max(0, attempt),
    RATE_LIMIT_RETRY_WAIT_MS.length - 1,
  );
  return Math.min(RATE_LIMIT_RETRY_WAIT_MS[index]!, maxMs);
}

export function providerRetryAfterMs(error: unknown): number | undefined {
  if (error && typeof error === "object" && "retryAfterSeconds" in error) {
    const seconds = (error as { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    if (
      typeof seconds === "number" &&
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return Math.ceil(seconds * 1000);
    }
  }
  const match = errorMessage(error).match(/retry after ([0-9.]+)\s*s/i);
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]!);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1000)
    : undefined;
}

export function rateLimitWaitMsFor(
  error: unknown,
  attempt: number,
  maxMs = Number.POSITIVE_INFINITY,
): number {
  const scheduled = rateLimitRetryWaitMs(attempt, maxMs);
  const hint = providerRetryAfterMs(error);
  return hint === undefined ? scheduled : Math.min(scheduled, hint);
}

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

export function isAuthKeyError(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 401 || status === 403;
}

export function isQuotaKeyError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status === 402) return true;
  return mentionsQuotaExhaustion(error);
}

export function isImmediateKeySwitchError(error: unknown): boolean {
  return isAuthKeyError(error) || isQuotaKeyError(error);
}

export function isKeyRotatableError(error: unknown, isRetriable: (e: unknown) => boolean): boolean {
  if (isRetriable(error)) return true;
  if (isImmediateKeySwitchError(error)) return true;
  const msg = errorMessage(error);
  if (/no completion text|response was empty|empty response|returned no text/i.test(msg)) {
    return true;
  }
  return false;
}

export function isKeyCircleStopError(error: unknown): boolean {
  const status = errorStatus(error);
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
        event.waitMs !== undefined
          ? ` — retrying in ${Math.ceil(event.waitMs / 1000)}s`
          : "";
      const why = event.reason ?? "retrying";
      if (why === "rate limited" && secs) {
        return `⏳ ${event.provider}${idx}${keyPart} rate limited${secs}…`;
      }
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
