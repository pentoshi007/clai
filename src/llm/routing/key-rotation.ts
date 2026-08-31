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
  isServerUnavailable,
  MAX_RETRIES,
  MAX_RETRY_WAIT_MS,
  networkRetryWaitMs,
  retryWaitMs,
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
    // Quiet sticky start: never status-spam "using …" on every model step.
    // Surface only retries (composer countdown), switches (toast + status), exhausted.
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

/**
 * Run complete/stream against all keys for one provider with circular rotation.
 * Returns result on success; throws ProviderError-like aggregate on hard stop;
 * returns `{ exhausted: true, lastError }` when the key circle is done.
 */
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
  // A pinned operation uses the sticky key only: rotating would send the same
  // large prompt again under a different credential.
  const plan = singleDispatch ? fullPlan.slice(0, 1) : fullPlan;
  if (plan.length === 0) {
    throw new Error(
      `all ${slots.length} API key${slots.length === 1 ? "" : "s"} for ${providerId} are disabled — re-enable one to use this provider`,
    );
  }
  const enabledCount = plan.length;
  const multiKey = enabledCount > 1;
  // Single key: time-increasing retries (MAX_RETRIES+1 attempts).
  // Multi key: 2 attempts per key (initial + one retry), then next key.
  const maxPerKey = singleDispatch
    ? 1
    : attemptsPerKey(enabledCount, (opts.maxRetries ?? MAX_RETRIES) + 1);
  let lastError: unknown;

  // Endpoint failover: a provider can carry several base URLs (e.g. Modal
  // workspaces). On an auth/quota error the active endpoint may simply be the
  // wrong workspace for the key, so rotate the endpoint too before giving up.
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

    // Announce only when rotating after a failure — never re-toast the sticky
    // key on every agent step ("using [2/4]" spam).
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
        // Sticky success only for stored multi-key (not env-only synthetic).
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

        // An admission guard that fires while recovering from a real failure
        // hides that failure. Report the cause the user can act on.
        if (isOperationPolicyError(error) && previousError !== undefined) {
          throw previousError;
        }

        // 404/422: other keys for the same model will not help.
        if (isKeyCircleStopError(error)) {
          throw error;
        }

        // Auth / quota (402 credits): never sleep on the same key — switch now.
        if (isImmediateKeySwitchError(error)) {
          // A workspace-mismatched endpoint (e.g. Modal "different workspace")
          // will fail for every key, so rotate the endpoint before the key.
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
            // Always advance (or exit plan after last key) so every key is tried.
            break;
          }
          // Single key — surface immediately (no pointless multi-second backoff).
          throw error;
        }

        const rotatable = isKeyRotatableError(error, isRetriableError);
        if (!rotatable) {
          // e.g. 413 — bubble so outer provider fallback can try another provider.
          throw error;
        }

        const canRetrySame = attempt + 1 < maxPerKey;
        if (canRetrySame) {
          const wait =
            isRateLimited(error) || isServerUnavailable(error)
              ? retryWaitMs(error, attempt)
              : networkRetryWaitMs(attempt);
          if (wait > MAX_RETRY_WAIT_MS) {
            // Don't burn the whole multi-key circle on one impossible wait —
            // move to the next key when multi; single-key still exhausts.
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
        // Exhausted attempts for this key → next in circle (if any).
        break;
      }
    }

    // Endpoint providers pair each key with a workspace URL (a Modal token
    // only works on its own workspace's endpoint). Advancing the key without
    // advancing the endpoint guarantees a workspace-mismatch 401, so move to
    // the next endpoint first and let the next key pair with it. Auth/quota
    // errors keep their dedicated endpoint-rotation path above.
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

  // Single-key rate-limit exhaustion: preserve historical UX string.
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
