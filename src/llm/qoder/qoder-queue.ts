import { ProviderError } from "../http.js";
import type { ProviderAuth } from "../provider.js";
import { currentSessionAffinity } from "../session-affinity.js";
import { sessionCacheAffinityKey } from "../cache-affinity.js";
import { QODER_INFERENCE_ORIGIN } from "./qoder-auth.js";
import { parseQoderCredential, type QoderCredential } from "./qoder-credential.js";
import { fetchSignedQoderRequest, qoderRequestSignal, readQoderResponseBody } from "./qoder-http.js";
import { withQoderCredential } from "./qoder-refresh.js";
import { parseQoderQueueStatus, QoderModelQueuedError, qoderResponseError, type QoderQueueStatus } from "./qoder-response.js";

export interface QoderRequestIdentity {
  requestId: string;
  requestSetId: string;
  sessionId: string;
}

function requestIdentity(): QoderRequestIdentity {
  const affinity = currentSessionAffinity();
  const key = affinity ? sessionCacheAffinityKey(affinity).slice(5, 37) : undefined;
  const sessionId = key
    ? `${key.slice(0, 8)}-${key.slice(8, 12)}-5${key.slice(13, 16)}-8${key.slice(17, 20)}-${key.slice(20)}`
    : crypto.randomUUID();
  return { requestId: crypto.randomUUID(), requestSetId: crypto.randomUUID(), sessionId };
}

function queueWaitLimitMs(): number {
  const value = Number(process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS);
  return Number.isFinite(value) && value > 0 ? value : 3_600_000;
}

function pollDelayMs(status: QoderQueueStatus): number {
  return Math.min(30_000, Math.max(500, (status.retryAfterSeconds ?? 30) * 1000));
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Qoder queue wait cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function queueEnded(message: string, body?: string): ProviderError {
  return new ProviderError(`Qoder model queue ${message}. Retry later or choose another model with /model.`, undefined, body, undefined, false);
}

interface QueueWaitOptions {
  auth: ProviderAuth;
  identity: QoderRequestIdentity;
  modelKey: string;
  deadline: number;
  maxWaitMs: number;
  signal?: AbortSignal | undefined;
  onStatus?: ((message: string) => void) | undefined;
}

async function checkQueue(options: QueueWaitOptions, status: QoderQueueStatus): Promise<QoderQueueStatus> {
  const query = new URLSearchParams({ requestSetId: options.identity.requestSetId, modelKey: status.modelKey ?? options.modelKey });
  if (status.queueType) query.set("queueType", status.queueType);
  return withQoderCredential(options.auth, async (credential) => {
    const signal = qoderRequestSignal(options.signal, Math.min(30_000, options.deadline - Date.now()));
    const response = await fetchSignedQoderRequest(credential, {
      endpoint: QODER_INFERENCE_ORIGIN,
      path: `/api/v2/service/ask/queue/status?${query}`,
      method: "GET",
      headers: { Accept: "application/json", "X-Request-ID": options.identity.requestId, "X-Session-ID": options.identity.sessionId },
      signal,
    });
    const raw = await readQoderResponseBody(response, signal);
    if (!response.ok) throw qoderResponseError(response.status, raw);
    const queue = parseQoderQueueStatus(raw);
    if (!queue) throw queueEnded("status response is invalid", raw);
    return queue;
  }, options.onStatus, () => !options.signal?.aborted);
}

function checkWaitLimit(options: QueueWaitOptions, body: string): void {
  options.signal?.throwIfAborted();
  if (Date.now() >= options.deadline) throw queueEnded(`wait limit reached after ${Math.ceil(options.maxWaitMs / 1000)}s`, body);
}

function queuedStatusMessage(status: QoderQueueStatus, modelKey: string): string {
  const count = status.queueCount === undefined ? "" : `; ${status.queueCount} ahead`;
  return `ℹ Qoder ${modelKey} request queued${count} — checking again in ${Math.ceil(pollDelayMs(status) / 1000)}s`;
}

async function waitForQueue(options: QueueWaitOptions, initial: QoderModelQueuedError): Promise<void> {
  let status = initial.queue;
  let firstPoll = true;
  let failures = 0;
  for (;;) {
    checkWaitLimit(options, initial.body ?? "");
    options.onStatus?.(queuedStatusMessage(status, options.modelKey));
    if (!firstPoll) await wait(Math.min(pollDelayMs(status), options.deadline - Date.now()), options.signal);
    firstPoll = false;
    checkWaitLimit(options, initial.body ?? "");
    try {
      status = await checkQueue(options, status);
      failures = 0;
    } catch (error) {
      checkWaitLimit(options, initial.body ?? "");
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) throw error;
      if (error instanceof ProviderError && error.status === 404) throw queueEnded("status endpoint is not available", error.body);
      if (++failures >= 3) throw queueEnded("status polling failed after 3 checks", error instanceof ProviderError ? error.body : undefined);
      options.onStatus?.(`ℹ Qoder queue status check failed — retrying in 30s (${failures}/3)`);
      status = { ...status, retryAfterSeconds: undefined };
      continue;
    }
    checkWaitLimit(options, initial.body ?? "");
    if (status.isQueued === false) {
      const readyDelay = status.retryAfterSeconds && status.retryAfterSeconds > 0 ? pollDelayMs(status) : 0;
      await wait(Math.min(readyDelay, options.deadline - Date.now()), options.signal);
      checkWaitLimit(options, initial.body ?? "");
      options.onStatus?.("ℹ Qoder model available — continuing request");
      return;
    }
    if (status.isQueued !== true && status.serviceAvailable !== false) throw queueEnded("status cannot be recovered", initial.body);
  }
}

async function releaseQueueLease(credential: QoderCredential, identity: QoderRequestIdentity, modelKey: string, startedAt: number): Promise<void> {
  if (!credential.uid) return;
  const signal = qoderRequestSignal(undefined, 3_000);
  const body = JSON.stringify({
    payload: JSON.stringify({ model_key: modelKey, request_set_id: identity.requestSetId, user_id: credential.uid, time_consumed: Math.max(0, Date.now() - startedAt) }),
    encodeVersion: "1",
  });
  const response = await fetchSignedQoderRequest(credential, {
    endpoint: QODER_INFERENCE_ORIGIN, path: "/api/v2/service/ask/finish?Encode=1", method: "POST", body,
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": crypto.randomUUID() }, signal,
  });
  const raw = await readQoderResponseBody(response, signal);
  if (!response.ok) throw qoderResponseError(response.status, raw);
}

export async function withQoderModelQueue<T>(options: {
  auth: ProviderAuth;
  modelKey: string;
  run: (credential: QoderCredential, identity: QoderRequestIdentity) => Promise<T>;
  canRetry: () => boolean;
  signal?: AbortSignal | undefined;
  onStatus?: ((message: string) => void) | undefined;
}): Promise<T> {
  const identity = requestIdentity();
  const leasedModels = new Set<string>();
  const startedAt = Date.now();
  const maxWaitMs = queueWaitLimitMs();
  let deadline: number | undefined;
  let recoveries = 0;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      try {
        return await withQoderCredential(options.auth, (credential) => {
          identity.requestId = crypto.randomUUID();
          return options.run(credential, identity);
        }, options.onStatus, options.canRetry);
      } catch (error) {
        if (!(error instanceof QoderModelQueuedError)) throw error;
        leasedModels.add(error.queue.modelKey ?? options.modelKey);
        if (!options.canRetry()) throw error;
        if (recoveries++ >= 10) throw queueEnded("recovery limit reached after 10 attempts", error.body);
        deadline ??= Date.now() + maxWaitMs;
        await waitForQueue({ ...options, identity, deadline, maxWaitMs }, error);
      }
    }
  } finally {
    if (leasedModels.size > 0 && options.auth.apiKey) {
      const credential = parseQoderCredential(options.auth.apiKey);
      const releases = await Promise.allSettled([...leasedModels].map((modelKey) => releaseQueueLease(credential, identity, modelKey, startedAt)));
      if (!options.signal?.aborted && releases.some((release) => release.status === "rejected")) {
        options.onStatus?.("ℹ Qoder queue lease release failed; the server will release it automatically");
      }
    }
  }
}
