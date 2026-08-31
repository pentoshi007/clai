
import { lookup as defaultDnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";

import { Capture } from "./capture.js";
import { DEFAULT_RESPONSE_MODE, RESPONSE_MODES, type ResponseMode, type WebFetchArgs, type WebFetchErrorKind, type WebFetchOutcome } from "./types.js";
import { DnsLookupFn, HttpRequestFn, HttpsRequestFn, networkError, runRequestLoop, timeoutError } from "./request-loop.js";
import { validateArgs } from "./validate-args.js";
import { buildSuccessOutcome, errorOutcome } from "./response-body.js";
export type { DnsLookupFn, HttpRequestFn, HttpsRequestFn } from "./request-loop.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Injection points for {@link webFetchCore}. Each defaults to the
 * corresponding `node:` built-in so production code does not need to
 * supply anything; tests stub these to drive the pipeline without
 * touching the network.
 */
export interface WebFetchCoreOptions {
  /** HTTPS transport. Defaults to `https.request`. */
  httpsRequest?: HttpsRequestFn;
  /** HTTP transport. Defaults to `http.request`. */
  httpRequest?: HttpRequestFn;
  /** DNS resolver. Defaults to `dns/promises.lookup`. */
  dnsLookup?: DnsLookupFn;
  /** Wall-clock source for timing fields. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Caller abort (turn cancel / stall watchdog). When aborted, the
   * in-flight hop is torn down immediately — without this, Esc/Ctrl+C
   * and the stall watchdog could leave `web.fetch` hung until its own
   * 30s timer fired (or forever if a socket ignored that timer).
   */
  signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Run the full `web.fetch` pipeline for the given arguments.
 *
 * Returns a typed {@link WebFetchOutcome}. The outcome is never thrown
 * — argument validation failures, SSRF blocks, network errors, HTTP
 * errors, and timeouts all surface as `ok=false` with a categorical
 * `error.kind` and a human-readable message. The `metadata` field is
 * always populated: pipeline stages that completed before the failure
 * are surfaced (e.g. `resolvedIp` when DNS succeeded but a 4xx came
 * back), and stages that did not run carry default zero/empty values.
 */
export async function webFetchCore(
  args: WebFetchArgs,
  options: WebFetchCoreOptions = {},
): Promise<WebFetchOutcome> {
  const now = options.now ?? (() => Date.now());
  const httpsRequestFn = options.httpsRequest ?? (https.request as HttpsRequestFn);
  const httpRequestFn = options.httpRequest ?? (http.request as HttpRequestFn);
  const dnsLookupFn = options.dnsLookup ?? defaultDnsLookup;

  const t0 = now();

  // --------------------------------------------------------------------- 1
  // Argument validation. Run synchronously before any I/O so a malformed
  // call never reaches DNS or the network.
  const validated = validateArgs(args);
  if (!validated.ok) {
    return errorOutcome({
      requestedUrl: typeof args.url === "string" ? args.url : "",
      finalUrl: typeof args.url === "string" ? args.url : "",
      mode: resolveResponseMode(args.responseMode),
      error: validated.error,
      now,
      t0,
    });
  }

  const a = validated.value;

  // --------------------------------------------------------------------- 2
  // Wire up a single AbortController + 30 s wall-clock timer. The signal
  // is passed to DNS, the request, and the body reader so an abort
  // anywhere in the pipeline collapses every dangling listener.
  // Also forward the caller's AbortSignal so turn cancel / stall watchdog
  // actually kill the fetch (previously only the local timer was wired).
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, a.timeoutMs);
  // `unref` so the timer never holds the event loop open if the caller
  // forgets to await us. `setTimeout` returns a `Timeout` in Node which
  // exposes `.unref()`; the cast keeps lib.dom.d.ts happy.
  (timeoutHandle as unknown as { unref?: () => void }).unref?.();

  const callerSignal = options.signal;
  const onCallerAbort = (): void => {
    callerAborted = true;
    controller.abort();
  };
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort);
  }

  const initialUrl = new URL(a.url);
  const isHttps = initialUrl.protocol === "https:";
  const capture = new Capture({
    isHttps,
    finalHostname: initialUrl.hostname,
  });

  let lastUrl = a.url;

  try {
    // ----------------------------------------------------------------- 3-9
    // Run the redirect-aware request loop.
    const result = await runRequestLoop({
      args: a,
      capture,
      controller,
      now,
      t0,
      httpsRequestFn,
      httpRequestFn,
      dnsLookupFn,
    });
    lastUrl = result.lastUrl;

    if (!result.ok) {
      return errorOutcome({
        requestedUrl: a.url,
        finalUrl: lastUrl,
        mode: a.responseMode,
        capture,
        error: result.error,
        now,
        t0,
        includeHeaders: a.includeHeaders,
        includeTls: a.includeTls,
        includeTiming: a.includeTiming,
        includeRedirectChain: a.includeRedirectChain,
        redactSensitive: a.redactSensitive,
      });
    }

    // ----------------------------------------------------------------- 10
    // Build a successful WebFetchOutcome with redactions and budget
    // enforcement applied to the captured fields.
    return buildSuccessOutcome({
      args: a,
      capture,
      lastUrl: result.lastUrl,
      body: result.body,
      bytesReceived: result.bytesReceived,
      truncated: result.truncated,
      ...(result.truncatedAt !== undefined
        ? { truncatedAt: result.truncatedAt }
        : {}),
      contentType: result.contentType,
      now,
      t0,
    });
  } catch (err) {
    // Runaway exception: surface as "network" so the caller still gets
    // a typed outcome instead of a thrown Error.
    if (timedOut && !callerAborted) {
      return errorOutcome({
        requestedUrl: a.url,
        finalUrl: lastUrl,
        mode: a.responseMode,
        capture,
        error: timeoutError(lastUrl, t0, now),
        now,
        t0,
        includeHeaders: a.includeHeaders,
        includeTls: a.includeTls,
        includeTiming: a.includeTiming,
        includeRedirectChain: a.includeRedirectChain,
        redactSensitive: a.redactSensitive,
      });
    }
    if (callerAborted || controller.signal.aborted) {
      return errorOutcome({
        requestedUrl: a.url,
        finalUrl: lastUrl,
        mode: a.responseMode,
        capture,
        error: {
          kind: "timeout",
          message: callerAborted
            ? "web.fetch aborted by caller (turn cancelled or stall watchdog)."
            : timeoutError(lastUrl, t0, now).message,
          url: lastUrl,
        },
        now,
        t0,
        includeHeaders: a.includeHeaders,
        includeTls: a.includeTls,
        includeTiming: a.includeTiming,
        includeRedirectChain: a.includeRedirectChain,
        redactSensitive: a.redactSensitive,
      });
    }
    return errorOutcome({
      requestedUrl: a.url,
      finalUrl: lastUrl,
      mode: a.responseMode,
      capture,
      error: networkError(lastUrl, err),
      now,
      t0,
      includeHeaders: a.includeHeaders,
      includeTls: a.includeTls,
      includeTiming: a.includeTiming,
      includeRedirectChain: a.includeRedirectChain,
      redactSensitive: a.redactSensitive,
    });
  } finally {
    clearTimeout(timeoutHandle);
    if (callerSignal) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/**
 * Return `responseMode` resolved against the default. Used in the
 * pre-validation error path where {@link NormalisedArgs} is not
 * available yet but the metadata still needs a `mode` value.
 */
function resolveResponseMode(mode: ResponseMode | undefined): ResponseMode {
  if (mode === undefined) return DEFAULT_RESPONSE_MODE;
  if (RESPONSE_MODES.includes(mode)) return mode;
  return DEFAULT_RESPONSE_MODE;
}

// ---------------------------------------------------------------------------
// Request loop (DNS pin + connect + redirect)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Single hop: pinned-IP request + response stream
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Body streaming + classification
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Outcome assembly
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

// Re-export the discriminated-error union so adapters in 4.x can
// branch on `error.kind` without re-importing from `types.ts`.
export type { WebFetchErrorKind };
