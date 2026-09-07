import {
  getActiveProviderEndpoint,
  getProviderEndpoints,
  providerUsesEndpoints,
  setActiveProviderEndpoint,
} from "../../store/config.js";
import { getProviderKeys, markProviderKeySuccess } from "../../store/keys.js";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import { ProviderError } from "../http.js";
import {
  attemptsPerKey,
  buildKeyAttemptPlan,
  formatKeyEventStatus,
  isImmediateKeySwitchError,
  isKeyCircleStopError,
  isKeyRotatableError,
  isQuotaKeyError,
} from "../key-rotation.js";
import type { ProviderKeyEvent } from "../key-rotation.js";
import { isOperationPolicyError } from "../operation-ledger.js";
import { maskSecretTail } from "../provider.js";
import type { LlmProvider, ProviderAuth } from "../provider.js";
import type { ProviderKeyEventHandler } from "../router.js";
import { tryCompleteOnce } from "./attempt-complete.js";
import { tryStreamOnce } from "./attempt-stream.js";
import {
  isRateLimited,
  isRetriableError,
  isServerErrorFailure,
  isServerUnavailable,
  markServerErrorAttempts,
  MAX_RETRIES,
  MAX_RETRY_WAIT_MS,
  networkRetryWaitMs,
  retryWaitMs,
  SERVER_ERROR_MAX_ATTEMPTS,
  sleep,
} from "./error-classification.js";
import { authForSlot } from "./provider-selection.js";

function failureReason(error: unknown): string {
  if (isRateLimited(error)) return "rate limited";
  if (isQuotaKeyError(error)) {
    const status =
      error instanceof ProviderError && error.status
        ? ` (${error.status})`
        : "";
    return `insufficient credits${status}`;
  }
  if (error instanceof ProviderError && error.status) {
    if (error.status === 401 || error.status === 403) {
      return `auth failed (${error.status})`;
    }
    return `server error (${error.status})`;
  }
  return "connection glitch";
}

type EmitKey = (event: ProviderKeyEvent) => void;

export function makeKeyEmitter(
  onStatus?: (message: string) => void,
  onKeyEvent?: ProviderKeyEventHandler,
): EmitKey {
  return (event) => {
    onKeyEvent?.(event);
    if (event.type === "using") return;
    const line = formatKeyEventStatus(event);
    if (
      event.type === "retry" ||
      event.type === "switch" ||
      event.type === "exhausted"
    ) {
      onStatus?.(line);
    }
  };
}

export async function runWithKeyRotation<T>(opts: {
  providerId: ProviderId;
  provider: LlmProvider;
  request: CompletionRequest;
  model: string;
  emitKey: EmitKey;
  mode: "complete" | "stream";
  initialAttemptReason: "initial" | "fallback";
  onToken?: ((token: string) => void) | undefined;
  onStatus?: ((message: string) => void) | undefined;
  maxRetries?: number | undefined;
  singleDispatch?: boolean | undefined;
  retryRateLimits?: boolean | undefined;
  onSuccessfulRequest?:
    ((snapshot: SuccessfulRequestSnapshot) => void) | undefined;
}): Promise<T> {
  const { providerId, provider, request, model, emitKey } = opts;
  const singleDispatch = opts.singleDispatch === true;
  const multi = await getProviderKeys(providerId);
  const slots = multi.keys;
  if (slots.length === 0) {
    throw new Error("no API key configured");
  }

  const fullPlan = buildKeyAttemptPlan(slots.length, multi.activeIndex).filter(
    (index) => !slots[index]!.disabled,
  );
  // large prompt again under a different credential.
  const plan = singleDispatch ? fullPlan.slice(0, 1) : fullPlan;
  if (plan.length === 0) {
    throw new Error(
      `all ${slots.length} API key${slots.length === 1 ? "" : "s"} for ${providerId} are disabled — re-enable one to use this provider`,
    );
  }
  const enabledCount = plan.length;
  const multiKey = enabledCount > 1;
  const maxPerKey = singleDispatch
    ? 1
    : attemptsPerKey(enabledCount, (opts.maxRetries ?? MAX_RETRIES) + 1);
  let lastError: unknown;
  let serverAttempts = 0;

  const storedEndpoints =
    providerUsesEndpoints(providerId) && !singleDispatch
      ? getProviderEndpoints(providerId)
      : undefined;
  const endpointUrls = (storedEndpoints?.urls ?? []).filter(
    (url) => !(storedEndpoints?.disabledUrls ?? []).includes(url),
  );
  const activeEndpointUrl = storedEndpoints?.urls[storedEndpoints.activeIndex];
  const activeEndpointPos = activeEndpointUrl
    ? endpointUrls.indexOf(activeEndpointUrl)
    : -1;
  const endpointStart = activeEndpointPos >= 0 ? activeEndpointPos : 0;
  let endpointOffset = 0;
  const endpointCount = endpointUrls.length;
  const authForAttempt = (value: string | undefined): ProviderAuth => {
    if (endpointCount === 0) return authForSlot(providerId, value);
    const url = endpointUrls[(endpointStart + endpointOffset) % endpointCount]!;
    return { apiKey: value, baseUrl: url };
  };

  for (let planIdx = 0; planIdx < plan.length; planIdx++) {
    const keyIndex = plan[planIdx]!;
    const slot = slots[keyIndex]!;
    const auth = authForAttempt(slot.value);
    const tail = maskSecretTail(slot.value);

    if (planIdx > 0) {
      emitKey({
        type: "switch",
        provider: providerId,
        maskedTail: tail,
        keyIndex,
        keyCount: slots.length,
        ...(lastError ? { reason: failureReason(lastError) } : {}),
      });
    }

    for (let attempt = 0; attempt < maxPerKey; attempt++) {
      request.signal?.throwIfAborted();
      const attemptReason =
        planIdx === 0 && attempt === 0 ? opts.initialAttemptReason : "retry";
      try {
        let result: CompletionResult;
        if (opts.mode === "stream") {
          result = await tryStreamOnce(
            provider,
            providerId,
            request,
            model,
            auth,
            opts.onToken ?? (() => {}),
            opts.onStatus,
            attemptReason,
            singleDispatch,
            opts.onSuccessfulRequest,
          );
        } else {
          result = await tryCompleteOnce(
            provider,
            providerId,
            request,
            model,
            auth,
            attemptReason,
            opts.onStatus,
            singleDispatch,
          );
        }
        if (multi.source !== "env" && multi.source !== "local") {
          void markProviderKeySuccess(providerId, keyIndex).catch(() => {});
        }
        if (storedEndpoints && endpointCount > 0) {
          const winningUrl =
            endpointUrls[(endpointStart + endpointOffset) % endpointCount]!;
          const storedIndex = storedEndpoints.urls.indexOf(winningUrl);
          const authoritative = getActiveProviderEndpoint(providerId);
          if (
            storedIndex >= 0 &&
            storedIndex !== storedEndpoints.activeIndex &&
            (authoritative === "" ||
              storedEndpoints.urls.includes(authoritative))
          ) {
            try {
              setActiveProviderEndpoint(providerId, storedIndex);
            } catch {}
          }
        }
        return result as T;
      } catch (error) {
        const previousError = lastError;
        lastError = error;

        if (isServerErrorFailure(error)) {
          serverAttempts += 1;
          markServerErrorAttempts(error, serverAttempts);
        }

        if (isOperationPolicyError(error) && previousError !== undefined) {
          throw previousError;
        }

        if (isKeyCircleStopError(error)) {
          throw error;
        }

        if (isImmediateKeySwitchError(error)) {
          if (endpointCount > 1 && endpointOffset + 1 < endpointCount) {
            endpointOffset += 1;
            emitKey({
              type: "endpoint",
              provider: providerId,
              maskedTail: tail,
              reason: failureReason(error),
            });
            planIdx = -1;
            break;
          }
          if (multiKey) {
            break;
          }
          throw error;
        }

        const rotatable = isKeyRotatableError(error, isRetriableError);
        if (!rotatable) {
          throw error;
        }

        if (isRateLimited(error) && opts.retryRateLimits === false) {
          if (multiKey) break;
          throw error;
        }

        const serverBudgetExhausted =
          isServerErrorFailure(error) &&
          serverAttempts >= SERVER_ERROR_MAX_ATTEMPTS;
        const canRetrySame = attempt + 1 < maxPerKey && !serverBudgetExhausted;
        if (canRetrySame) {
          const wait =
            isRateLimited(error) || isServerUnavailable(error)
              ? retryWaitMs(error, attempt)
              : networkRetryWaitMs(attempt);
          if (wait > MAX_RETRY_WAIT_MS) {
            if (multiKey) break;
            throw error;
          }
          emitKey({
            type: "retry",
            provider: providerId,
            maskedTail: tail,
            reason: failureReason(error),
            waitMs: wait,
            keyIndex,
            keyCount: slots.length,
          });
          await sleep(wait, request.signal);
          continue;
        }
        break;
      }
    }

    if (
      isServerErrorFailure(lastError) &&
      serverAttempts >= SERVER_ERROR_MAX_ATTEMPTS
    ) {
      throw lastError;
    }

    if (
      planIdx >= 0 &&
      endpointCount > 1 &&
      planIdx + 1 < plan.length &&
      lastError &&
      !isImmediateKeySwitchError(lastError)
    ) {
      endpointOffset += 1;
      emitKey({
        type: "endpoint",
        provider: providerId,
        maskedTail: tail,
        reason: failureReason(lastError),
      });
    }
  }

  if (!multiKey && lastError && isRateLimited(lastError)) {
    opts.onStatus?.(
      `⏳ ${providerId} rate limited; staying on selected provider.`,
    );
  } else if (multiKey) {
    emitKey({
      type: "exhausted",
      provider: providerId,
      maskedTail: maskSecretTail(slots[plan[0]!]!.value),
      keyCount: slots.length,
      reason: lastError ? failureReason(lastError) : undefined,
    });
  }

  const err = lastError ?? new Error("all API keys failed");
  throw err;
}
