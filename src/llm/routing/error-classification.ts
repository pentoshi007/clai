import type {
  CompletionRequest,
  ProviderId,
  ReasoningEffort,
} from "../../types.js";
import {
  isReasoningUnsupported,
  learnedRouteEfforts,
} from "../capabilities.js";
import { fallbackEffortsFor } from "../effort-fallback.js";
import {
  isReasoningUnsupportedError,
  ProviderError,
  STREAM_STALL_MARKER,
} from "../http.js";
import { rateLimitWaitMsFor } from "../key-rotation.js";
import { quotaOrRateLimited } from "../quota-signals.js";
import { resolveBuiltInProfile } from "../provider-profiles.js";
import { EFFORT_SCALE, nearestAcceptedEffort } from "../reasoning-controls.js";
import { mentionsReasoning } from "../reasoning-errors.js";
import { streamAlreadyEmitted } from "../stream-progress.js";

export const MAX_RETRIES = 6;

export const MAX_RETRY_WAIT_MS = 120_000;

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    let cleanup = (): void => {};
    const abort = (): void => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Aborted"));
    };
    cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function isRateLimited(error: unknown): boolean {
  if (error instanceof ProviderError && error.status === 429) return true;
  return quotaOrRateLimited(error);
}

export function isServerUnavailable(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const status = error.status ?? 0;
  return status === 502 || status === 503 || status === 504;
}

function isServerError(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  const status = error.status ?? 0;
  return status >= 500 && status <= 504;
}

export function isReasoningRelatedServerError(error: unknown): boolean {
  if (!isServerError(error)) return false;
  return mentionsReasoning(error);
}

const UNIVERSAL_EFFORTS: ReadonlySet<string> = new Set([
  "none",
  "low",
  "medium",
  "high",
]);

const OPAQUE_PARAMETER_REJECTION_RE =
  /invalid request|invalid parameter|unsupported parameter|unknown parameter|unrecognized|extra inputs are not permitted|not a valid/i;

const NON_EFFORT_REJECTION_RE =
  /model is not supported|model is unavailable|model not found|no such model|unknown model|rate limit|quota|insufficient|authentication|authorization|permission/i;

function isOpaqueParameterRejection(
  error: unknown,
  effort: ReasoningEffort | undefined,
): boolean {
  if (!effort || UNIVERSAL_EFFORTS.has(effort)) return false;
  if (!(error instanceof ProviderError)) return false;
  const status = error.status ?? 0;
  const parameterRejected =
    (status === 400 || status === 422) &&
    OPAQUE_PARAMETER_REJECTION_RE.test(`${error.message}\n${error.body ?? ""}`);
  const upstreamCrashed = status >= 500 && status <= 504;
  if (!parameterRejected && !upstreamCrashed) return false;
  return !NON_EFFORT_REJECTION_RE.test(`${error.message}\n${error.body ?? ""}`);
}

export function shouldContinueEffortLadder(error: unknown): boolean {
  return (
    isReasoningUnsupportedError(error) || isReasoningRelatedServerError(error)
  );
}

export function effortCandidatesFor(
  providerId: ProviderId,
  model: string,
  requested: ReasoningEffort,
): readonly ReasoningEffort[] {
  const learned = learnedRouteEfforts(providerId, model);
  if (learned?.length) {
    const usable = learned.filter(
      (effort) => effort !== requested && effort !== "none",
    );
    const corrected = nearestAcceptedEffort(requested, usable);
    const scaledLearned = EFFORT_SCALE.find((effort) => effort === corrected);
    return scaledLearned ? [scaledLearned] : [];
  }
  const declared = resolveBuiltInProfile({ provider: providerId, model })
    .reasoning.acceptedEfforts;
  if (declared.length === 0) return fallbackEffortsFor(requested);
  const nearest = nearestAcceptedEffort(requested, declared);
  if (nearest !== undefined && nearest !== requested) {
    const scaled = EFFORT_SCALE.find((effort) => effort === nearest);
    return scaled ? [scaled] : [];
  }
  const requestedIndex = EFFORT_SCALE.indexOf(requested);
  const lower = declared
    .map((effort) => EFFORT_SCALE.findIndex((scaled) => scaled === effort))
    .filter((index) => index >= 0 && requestedIndex >= 0 && index < requestedIndex)
    .sort((a, b) => b - a)[0];
  if (lower === undefined) return [];
  return [EFFORT_SCALE[lower]!];
}

export function shouldEnterEffortLadder(
  error: unknown,
  thinking: CompletionRequest["thinking"],
  providerId: ProviderId,
  model: string,
  singleDispatch: boolean,
): boolean {
  if (isReasoningUnsupportedError(error)) return true;
  if (singleDispatch) return false;
  if (!thinking?.enabled) return false;
  if (isReasoningUnsupported(providerId, model)) return false;
  if (isReasoningRelatedServerError(error)) return true;
  return isOpaqueParameterRejection(error, thinking.effort);
}

export function isCacheOnlyColdError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const body = error instanceof ProviderError ? (error.body ?? "") : "";
  return /cache_only_cold|cache-only admission/i.test(`${message} ${body}`);
}

function isTransientNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const msg = message.toLowerCase();
  return (
    msg.includes("socket connection was closed unexpectedly") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("fetch failed") ||
    msg.includes("network error") ||
    msg.includes("timeout") ||
    msg.includes("unexpected end of file") ||
    msg.includes("premature close")
  );
}

export function isRetriableError(error: unknown): boolean {
  if (streamAlreadyEmitted(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (new RegExp(STREAM_STALL_MARKER, "i").test(message)) {
    if (/for \d+s after it had already started/i.test(message)) return false;
  }
  if (
    /stream stalled|request timed out before any response|stream transport timeout/i.test(
      message,
    )
  ) {
    return true;
  }
  if (isRateLimited(error)) return true;
  if (error instanceof ProviderError) {
    const status = error.status ?? 0;
    if (status >= 500 && status <= 504) {
      return true;
    }
  }
  return isTransientNetworkError(error);
}

export function retryWaitMs(error: unknown, attempt: number): number {
  if (isRateLimited(error)) {
    return rateLimitWaitMsFor(error, attempt, MAX_RETRY_WAIT_MS);
  }
  if (error instanceof ProviderError && error.retryAfterSeconds !== undefined) {
    return Math.ceil(error.retryAfterSeconds * 1000);
  }
  return Math.pow(3, attempt) * 2_000;
}

export function networkRetryWaitMs(attempt: number): number {
  return Math.pow(2, attempt) * 1_000;
}

export function isEmptyCompletionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /completed without a visible answer|no visible answer|returned no content|no completion text|response was empty|empty response|returned no text/i.test(
    message,
  );
}

export function isModelNotFoundError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 404 && status !== 400) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  if (status === 404) return true;
  return /model[_ ]?not[_ ]?found|no such model|unknown model|model does not exist|invalid model|unavailable[- ]model/.test(
    hay,
  );
}
