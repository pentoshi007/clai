/**
 * `web.fetch` core orchestration.
 *
 * This module is the deterministic, dependency-injected pipeline that
 * `src/tools/web/fetch.ts` (added in task 4.x) wraps in a `ToolResult`
 * adapter and audit-log emitter. The core itself returns a typed
 * {@link WebFetchOutcome} and never touches the registry, the safety
 * classifier, or `auditLog`.
 *
 * The pipeline implements the design's "Pipeline steps in detail"
 * sequence (`.kiro/specs/web-search-and-fetch/design.md`):
 *
 *   1. argument validation
 *   2. URL parse + SSRF pre-check on hostname literal
 *   3. DNS resolve + IP pin
 *   4. SSRF check on resolved IP
 *   5. pinned `https.request` (or `http.request`) with custom `lookup`
 *   6. TLS handshake capture
 *   7. response headers + body stream with `maxBytes` cap
 *   8. redirect handling (≤ {@link MAX_REDIRECT_HOPS}, re-running
 *      validation + SSRF + DNS at each hop)
 *   9. body classification (binary / raw / readable)
 *  10. metadata assembly + 64 KiB budget enforcement
 *
 * Every outbound transport call (DNS, HTTP, HTTPS) is injectable via
 * {@link WebFetchCoreOptions} so tests in epics 3.x, 4.x and 6.x can
 * stub the network deterministically without spinning up a real server.
 */

import { Buffer } from "node:buffer";
import { lookup as defaultDnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
  RequestOptions,
} from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import { Capture, type CapturedFields } from "./capture.js";
import { enforce as enforceBudget } from "./budget.js";
import { toReadableText } from "./readable.js";
import { applyToCookies, applyToHeaders } from "./redact.js";
import {
  classify as classifyIp,
  classifyHost,
  isAllowedScheme,
} from "./ssrf-guard.js";
import {
  DEFAULT_INCLUDE_HEADERS,
  DEFAULT_INCLUDE_REDIRECT_CHAIN,
  DEFAULT_INCLUDE_TIMING,
  DEFAULT_MAX_BYTES,
  DEFAULT_REDACT_SENSITIVE,
  DEFAULT_RESPONSE_MODE,
  FETCH_TIMEOUT_MS,
  HTTP_ERROR_BODY_PREVIEW_BYTES,
  MAX_MAX_BYTES,
  MAX_REDIRECT_HOPS,
  METADATA_BUDGET_BYTES,
  MIN_MAX_BYTES,
  RESPONSE_MODES,
  TRUNCATION_MARKER,
  type CookieInfo,
  type HeaderMap,
  type RedirectChain,
  type ResponseMode,
  type TimingInfo,
  type TlsInfo,
  type WebFetchArgs,
  type WebFetchError,
  type WebFetchErrorKind,
  type WebFetchMetadata,
  type WebFetchOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Signature of `node:dns/promises.lookup`. */
export type DnsLookupFn = typeof defaultDnsLookup;

/** Signature of `node:http.request` (the overload accepting URL + options). */
export type HttpRequestFn = (
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest;

/** Signature of `node:https.request` (same shape as {@link HttpRequestFn}). */
export type HttpsRequestFn = HttpRequestFn;

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
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Content-Type prefixes that always trigger the `binary-content` error
 * kind, regardless of `responseMode` (Requirements 2.9 + 2.30).
 */
const BINARY_CONTENT_TYPE_PATTERNS: readonly RegExp[] = [
  /^image\//i,
  /^application\/octet-stream/i,
  /^application\/pdf/i,
  /^video\//i,
];

/**
 * Content-Type prefixes that trigger HTML-to-readable-text conversion
 * in `responseMode="readable"` (Requirement 2.4). All other text
 * Content-Types pass through unchanged in that mode (Requirement 2.5).
 */
const HTML_CONTENT_TYPE_PATTERN = /^(text\/html|application\/xhtml\+xml)/i;

/** Default User-Agent sent on outbound `web.fetch` requests. */
const DEFAULT_USER_AGENT = "clai-web-fetch/1.0";

/** Statuses that carry a `Location` header and trigger a redirect hop. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

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
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);
  // `unref` so the timer never holds the event loop open if the caller
  // forgets to await us. `setTimeout` returns a `Timeout` in Node which
  // exposes `.unref()`; the cast keeps lib.dom.d.ts happy.
  (timeoutHandle as unknown as { unref?: () => void }).unref?.();

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
    if (timedOut) {
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
  }
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

/** Result of {@link validateArgs}: either a normalised arg bundle or an error. */
type ValidationResult =
  | { ok: true; value: NormalisedArgs }
  | { ok: false; error: WebFetchError };

/**
 * Argument bundle with every optional field resolved to a concrete
 * default per `types.ts`. Downstream code reads only this shape so the
 * defaults are not re-derived in multiple places.
 */
interface NormalisedArgs {
  url: string;
  maxBytes: number;
  includeHeaders: boolean;
  includeTls: boolean;
  includeTiming: boolean;
  includeRedirectChain: boolean;
  responseMode: ResponseMode;
  redactSensitive: boolean;
}

/**
 * Synchronously validate {@link WebFetchArgs} against Requirements 2.1,
 * 2.2, 2.12, 2.13, 2.33, 2.34, 5.4, and 7.1–7.3.
 *
 * Returns the normalised arg bundle on success. On the first violation
 * encountered, returns a `validation` error whose message names the
 * offending argument and the rule that was broken.
 */
function validateArgs(args: WebFetchArgs): ValidationResult {
  // url: required string, parses as absolute URL with http(s) scheme,
  // no whitespace, no ASCII control chars (Requirements 2.1, 2.12, 7.1, 7.3).
  if (typeof args.url !== "string" || args.url.length === 0) {
    return validationError("url is required and must be a non-empty string");
  }
  if (/\s/.test(args.url)) {
    return validationError(
      "url must not contain whitespace characters (Requirement 7.3)",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(args.url)) {
    return validationError(
      "url must not contain ASCII control characters (Requirement 7.3)",
    );
  }
  if (!isAllowedScheme(args.url)) {
    return {
      ok: false,
      error: {
        kind: "blocked-scheme",
        message: `Refusing scheme: ${schemeOf(args.url)}`,
        url: args.url,
      },
    };
  }

  // maxBytes: optional integer in [MIN_MAX_BYTES, MAX_MAX_BYTES] (2.2, 2.13).
  let maxBytes = DEFAULT_MAX_BYTES;
  if (args.maxBytes !== undefined) {
    if (
      typeof args.maxBytes !== "number" ||
      !Number.isInteger(args.maxBytes) ||
      args.maxBytes < MIN_MAX_BYTES ||
      args.maxBytes > MAX_MAX_BYTES
    ) {
      return validationError(
        `maxBytes must be an integer in [${MIN_MAX_BYTES}, ${MAX_MAX_BYTES}]`,
      );
    }
    maxBytes = args.maxBytes;
  }

  // includeHeaders: optional boolean (Requirement 2.34).
  if (args.includeHeaders !== undefined && typeof args.includeHeaders !== "boolean") {
    return validationError("includeHeaders must be a boolean");
  }
  const includeHeaders = args.includeHeaders ?? DEFAULT_INCLUDE_HEADERS;

  // includeTls: optional boolean. Default depends on scheme: true for
  // https://, false for http:// (Requirement 2.16, 2.34).
  if (args.includeTls !== undefined && typeof args.includeTls !== "boolean") {
    return validationError("includeTls must be a boolean");
  }
  const parsedUrl = new URL(args.url);
  const isHttps = parsedUrl.protocol === "https:";
  const includeTls = args.includeTls ?? isHttps;

  // includeTiming: optional boolean (Requirement 2.34).
  if (args.includeTiming !== undefined && typeof args.includeTiming !== "boolean") {
    return validationError("includeTiming must be a boolean");
  }
  const includeTiming = args.includeTiming ?? DEFAULT_INCLUDE_TIMING;

  // includeRedirectChain: optional boolean (Requirement 2.34).
  if (
    args.includeRedirectChain !== undefined &&
    typeof args.includeRedirectChain !== "boolean"
  ) {
    return validationError("includeRedirectChain must be a boolean");
  }
  const includeRedirectChain =
    args.includeRedirectChain ?? DEFAULT_INCLUDE_REDIRECT_CHAIN;

  // responseMode: optional, must be "readable" or "raw" (Requirement 2.33).
  if (args.responseMode !== undefined) {
    if (
      typeof args.responseMode !== "string" ||
      !RESPONSE_MODES.includes(args.responseMode)
    ) {
      return validationError(
        `responseMode must be one of: ${RESPONSE_MODES.join(", ")}`,
      );
    }
  }
  const responseMode: ResponseMode =
    args.responseMode ?? DEFAULT_RESPONSE_MODE;

  // redactSensitive: optional boolean (Requirement 2.34).
  if (
    args.redactSensitive !== undefined &&
    typeof args.redactSensitive !== "boolean"
  ) {
    return validationError("redactSensitive must be a boolean");
  }
  const redactSensitive = args.redactSensitive ?? DEFAULT_REDACT_SENSITIVE;

  return {
    ok: true,
    value: {
      url: args.url,
      maxBytes,
      includeHeaders,
      includeTls,
      includeTiming,
      includeRedirectChain,
      responseMode,
      redactSensitive,
    },
  };
}

function validationError(message: string): ValidationResult {
  return {
    ok: false,
    error: { kind: "validation", message },
  };
}

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

/**
 * Best-effort extraction of the scheme prefix for a URL string that may
 * not parse cleanly. Used only inside `blocked-scheme` error messages.
 */
function schemeOf(raw: string): string {
  const m = raw.match(/^([a-z][a-z0-9+.\-]*):/i);
  return m && typeof m[1] === "string" ? `${m[1]}:` : raw;
}

// ---------------------------------------------------------------------------
// Request loop (DNS pin + connect + redirect)
// ---------------------------------------------------------------------------

/** Internal context threaded through the request loop. */
interface RequestLoopContext {
  args: NormalisedArgs;
  capture: Capture;
  controller: AbortController;
  now: () => number;
  t0: number;
  httpsRequestFn: HttpsRequestFn;
  httpRequestFn: HttpRequestFn;
  dnsLookupFn: DnsLookupFn;
}

/** Result of {@link runRequestLoop}. */
type RequestLoopResult =
  | {
      ok: true;
      lastUrl: string;
      contentType: string | undefined;
      body: string;
      bytesReceived: number;
      truncated: boolean;
      truncatedAt?: number;
    }
  | {
      ok: false;
      lastUrl: string;
      error: WebFetchError;
    };

/**
 * Run up to {@link MAX_REDIRECT_HOPS} request hops. Each hop:
 *
 *   - parses the current URL
 *   - re-applies the SSRF pre-check on the hostname literal
 *   - resolves the hostname via {@link DnsLookupFn}, captures `dnsMs`
 *     and the resolved IP
 *   - re-applies the SSRF check on the resolved IP
 *   - builds a pinned-IP `https/http.request` with a custom `lookup`
 *     callback that returns the resolved IP synchronously
 *   - on a 3xx with `Location`, appends a redirect hop and loops
 *   - on a binary content type, returns `binary-content`
 *   - on a 4xx/5xx terminal, reads up to
 *     {@link HTTP_ERROR_BODY_PREVIEW_BYTES} bytes for the preview and
 *     returns `http-error`
 *   - on a 2xx terminal, reads the body up to `maxBytes` and returns
 *     success
 */
async function runRequestLoop(
  ctx: RequestLoopContext,
): Promise<RequestLoopResult> {
  let currentUrl = ctx.args.url;

  // We allow up to (1 initial + MAX_REDIRECT_HOPS redirects) requests:
  // hop indices 0..MAX_REDIRECT_HOPS inclusive. A redirect produced on
  // the final allowed iteration triggers the `redirect-limit` error
  // because following it would exceed the cap (Requirement 2.14,
  // Property 6).
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    // Re-validate at every hop. Requirement 2.11 + design "Pipeline
    // steps in detail" §8: each hop independently runs validation +
    // SSRF + DNS.
    if (!isAllowedScheme(currentUrl)) {
      return {
        ok: false,
        lastUrl: currentUrl,
        error: {
          kind: "blocked-scheme",
          message: `Refusing scheme: ${schemeOf(currentUrl)}`,
          url: currentUrl,
        },
      };
    }

    let parsed: URL;
    try {
      parsed = new URL(currentUrl);
    } catch {
      return {
        ok: false,
        lastUrl: currentUrl,
        error: {
          kind: "validation",
          message: `web.fetch: redirect target is not a valid URL: ${currentUrl}`,
          url: currentUrl,
        },
      };
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    ctx.capture.setHopContext(hostname);

    // SSRF pre-check on the hostname literal so e.g. https://127.0.0.1
    // fails before any DNS work is done.
    const hostClass = classifyHost(hostname);
    if (hostClass !== null) {
      return {
        ok: false,
        lastUrl: currentUrl,
        error: {
          kind: "blocked-address",
          message: `Refusing to fetch ${hostClass.class} address ${hostname} (host=${hostname})`,
          url: currentUrl,
        },
      };
    }

    // DNS resolve + pin IP for the actual TCP connect. Requirement 2.8
    // / 2.11: the SSRF check is run against the resolved IP, and the
    // socket is then connected to that exact IP via a custom `lookup`
    // callback so DNS rebinding can not swap the address out from
    // under us between resolve and connect.
    const dnsStart = ctx.now();
    let resolvedIp: string;
    let resolvedFamily: 4 | 6;
    try {
      const result = await ctx.dnsLookupFn(hostname, { family: 0 });
      resolvedIp = result.address;
      resolvedFamily = (result.family === 6 ? 6 : 4) as 4 | 6;
    } catch (err) {
      return {
        ok: false,
        lastUrl: currentUrl,
        error: networkError(currentUrl, err, "DNS resolution failed"),
      };
    }
    const dnsMs = ctx.now() - dnsStart;
    ctx.capture.markDnsResolved(dnsMs, resolvedIp);

    const ipClass = classifyIp(resolvedIp);
    if (ipClass !== null) {
      return {
        ok: false,
        lastUrl: currentUrl,
        error: {
          kind: "blocked-address",
          message: `Refusing to fetch ${ipClass.class} address ${resolvedIp} (host=${hostname})`,
          url: currentUrl,
        },
      };
    }

    // Issue the pinned-IP request and consume the response.
    const hopResult = await issueHop({
      ctx,
      currentUrl,
      parsed,
      resolvedIp,
      resolvedFamily,
      hop,
    });

    if (hopResult.kind === "redirect") {
      // Append the *current* hop to the chain and follow.
      ctx.capture.addRedirectHop(
        currentUrl,
        hopResult.status,
        hopResult.location,
      );
      // Resolve next URL: handle relative Locations against the
      // *current* hop's URL.
      let nextUrl: string;
      try {
        nextUrl = new URL(hopResult.location, parsed).toString();
      } catch {
        return {
          ok: false,
          lastUrl: currentUrl,
          error: {
            kind: "validation",
            message: `web.fetch: redirect Location is not a valid URL: ${hopResult.location}`,
            url: currentUrl,
          },
        };
      }

      if (hop + 1 > MAX_REDIRECT_HOPS) {
        return {
          ok: false,
          lastUrl: nextUrl,
          error: {
            kind: "redirect-limit",
            message: `web.fetch: exceeded ${MAX_REDIRECT_HOPS}-redirect limit (last url=${nextUrl})`,
            url: nextUrl,
          },
        };
      }

      currentUrl = nextUrl;
      continue;
    }

    // Terminal hop (2xx/4xx/5xx or transport failure). Append the
    // final hop to the redirect chain so callers see the complete
    // path, then return.
    if (hopResult.kind === "terminal") {
      ctx.capture.addRedirectHop(currentUrl, hopResult.status);
      return {
        ok: true,
        lastUrl: currentUrl,
        contentType: hopResult.contentType,
        body: hopResult.body,
        bytesReceived: hopResult.bytesReceived,
        truncated: hopResult.truncated,
        ...(hopResult.truncatedAt !== undefined
          ? { truncatedAt: hopResult.truncatedAt }
          : {}),
      };
    }

    // hopResult.kind === "error"
    return {
      ok: false,
      lastUrl: currentUrl,
      error: hopResult.error,
    };
  }

  // Should be unreachable — the loop body either returns or sets
  // currentUrl and continues. A defensive fallback keeps TS happy.
  return {
    ok: false,
    lastUrl: currentUrl,
    error: {
      kind: "redirect-limit",
      message: `web.fetch: exceeded ${MAX_REDIRECT_HOPS}-redirect limit (last url=${currentUrl})`,
      url: currentUrl,
    },
  };
}

// ---------------------------------------------------------------------------
// Single hop: pinned-IP request + response stream
// ---------------------------------------------------------------------------

interface IssueHopArgs {
  ctx: RequestLoopContext;
  currentUrl: string;
  parsed: URL;
  resolvedIp: string;
  resolvedFamily: 4 | 6;
  hop: number;
}

/** Outcome of one HTTP/HTTPS hop. */
type HopOutcome =
  | {
      kind: "redirect";
      status: number;
      location: string;
    }
  | {
      kind: "terminal";
      status: number;
      contentType: string | undefined;
      body: string;
      bytesReceived: number;
      truncated: boolean;
      truncatedAt?: number;
    }
  | {
      kind: "error";
      error: WebFetchError;
    };

/**
 * Issue a single GET request to `parsed.href` while pinning the TCP
 * connection to `resolvedIp` via a custom `lookup` callback.
 *
 * The function handles every shape the response can take:
 *   - 3xx with a `Location` header → returns `{kind: "redirect"}`
 *   - 3xx without a `Location`     → treated as a terminal 3xx
 *   - binary content type          → returns a `binary-content` error
 *   - 4xx / 5xx                    → reads up to
 *     {@link HTTP_ERROR_BODY_PREVIEW_BYTES} bytes for the preview and
 *     returns an `http-error` error (Requirement 6.4)
 *   - 2xx                          → reads body up to `args.maxBytes`
 *     and returns `{kind: "terminal"}`
 *
 * Timing for `tcpMs`, `tlsMs`, and `ttfbMs` is recorded on the
 * shared {@link Capture} and corresponds to the *current* hop. The
 * builder always reflects the *last* hop's measurements (per its
 * documented per-hop semantics).
 */
async function issueHop(input: IssueHopArgs): Promise<HopOutcome> {
  const { ctx, currentUrl, parsed, resolvedIp, resolvedFamily } = input;
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? ctx.httpsRequestFn : ctx.httpRequestFn;
  const dnsEndedAt = ctx.now();

  const requestOptions: RequestOptions = {
    method: "GET",
    signal: ctx.controller.signal,
    headers: {
      // Identify ourselves and ask the server for prose-friendly bodies.
      "user-agent": DEFAULT_USER_AGENT,
      accept: "*/*",
      "accept-encoding": "identity",
      // Honor the URL's hostname for SNI and the Host header even though
      // the socket is connecting to `resolvedIp`.
      host: parsed.host,
    },
    // Pinned-IP lookup. Returns `resolvedIp` synchronously so the
    // request's socket connects to the exact address the SSRF guard
    // already classified.
    lookup: pinnedLookup(resolvedIp, resolvedFamily),
  };

  return new Promise<HopOutcome>((resolve) => {
    let req: ClientRequest;
    try {
      req = requestFn(parsed, requestOptions);
    } catch (err) {
      resolve({
        kind: "error",
        error: networkError(currentUrl, err),
      });
      return;
    }

    let socketObserved = false;
    let connectAt: number | undefined;
    let secureAt: number | undefined;
    let requestSentAt: number | undefined;
    let settled = false;

    const finish = (outcome: HopOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    req.on("socket", (socket: Socket) => {
      if (socketObserved) return;
      socketObserved = true;

      // `lookup` event fires once DNS has been resolved (our pinned
      // lookup fires it synchronously). We do not record `dnsMs` here
      // because we already measured it around `dnsLookupFn`.
      socket.once("connect", () => {
        connectAt = ctx.now();
        const tcpMs = connectAt - dnsEndedAt;
        ctx.capture.markTcpConnected(tcpMs);
      });
      if (isHttps) {
        // `secureConnect` is emitted by `tls.TLSSocket` once the
        // handshake completes.
        (socket as TLSSocket).once("secureConnect", () => {
          secureAt = ctx.now();
          if (connectAt !== undefined) {
            const tlsMs = secureAt - connectAt;
            ctx.capture.markTlsHandshaked(tlsMs, socket as TLSSocket);
          }
        });
      }
    });

    req.on("error", (err: Error) => {
      // AbortController-driven aborts surface as `AbortError`.
      if (ctx.controller.signal.aborted) {
        finish({
          kind: "error",
          error: timeoutError(currentUrl, ctx.t0, ctx.now),
        });
        return;
      }
      finish({
        kind: "error",
        error: networkError(currentUrl, err),
      });
    });

    req.on("response", (res: IncomingMessage) => {
      const ttfbMs = (() => {
        if (typeof requestSentAt === "number") {
          return ctx.now() - requestSentAt;
        }
        return ctx.now() - dnsEndedAt;
      })();

      const status = typeof res.statusCode === "number" ? res.statusCode : 0;
      const headers = res.headers;
      ctx.capture.markResponse(status, headers, ttfbMs);

      // Capture every Set-Cookie header value (parsed individually)
      // for the cookies array. Node returns a string[] for `set-cookie`
      // when there are multiple lines.
      const setCookieValues = collectSetCookieValues(headers);
      for (const value of setCookieValues) {
        ctx.capture.addSetCookieHeader(value);
      }

      const contentType = headerString(headers["content-type"]);

      // Redirect handling (Requirement 2.11/2.14).
      if (status >= 300 && status < 400 && REDIRECT_STATUSES.has(status)) {
        const location = headerString(headers["location"]);
        if (typeof location === "string" && location.length > 0) {
          // Drain the response body to free the socket.
          res.resume();
          finish({ kind: "redirect", status, location });
          return;
        }
        // 3xx without Location: fall through and treat as terminal.
      }

      // Binary content rejection (Requirements 2.9 + 2.30) before we
      // read any body bytes — including in `responseMode="raw"`.
      if (
        typeof contentType === "string" &&
        BINARY_CONTENT_TYPE_PATTERNS.some((re) => re.test(contentType))
      ) {
        res.resume();
        finish({
          kind: "error",
          error: {
            kind: "binary-content",
            message: `Refusing binary content type: ${contentType}`,
            url: currentUrl,
            status,
          },
        });
        return;
      }

      // HTTP error (Requirement 6.4). Read up to 4 KiB for the preview
      // and surface as `http-error`.
      if (status >= 400 && status < 600) {
        readBody(res, HTTP_ERROR_BODY_PREVIEW_BYTES, ctx.controller).then(
          ({ body, truncated, bytesReceived }) => {
            const preview = renderBodyPreview(body, truncated, bytesReceived);
            finish({
              kind: "error",
              error: {
                kind: "http-error",
                message: `${status} ${currentUrl}`,
                status,
                url: currentUrl,
                bodyPreview: preview,
              },
            });
          },
          (err) => {
            if (ctx.controller.signal.aborted) {
              finish({
                kind: "error",
                error: timeoutError(currentUrl, ctx.t0, ctx.now),
              });
              return;
            }
            finish({
              kind: "error",
              error: networkError(currentUrl, err),
            });
          },
        );
        return;
      }

      // Successful (2xx or non-Location 3xx) terminal hop.
      readBody(res, ctx.args.maxBytes, ctx.controller).then(
        ({ body, truncated, bytesReceived }) => {
          const text = classifyAndDecodeBody({
            mode: ctx.args.responseMode,
            contentType,
            body,
            maxBytes: ctx.args.maxBytes,
          });
          finish({
            kind: "terminal",
            status,
            contentType,
            body: text,
            bytesReceived,
            truncated,
            ...(truncated ? { truncatedAt: bytesReceived } : {}),
          });
        },
        (err) => {
          if (ctx.controller.signal.aborted) {
            finish({
              kind: "error",
              error: timeoutError(currentUrl, ctx.t0, ctx.now),
            });
            return;
          }
          finish({
            kind: "error",
            error: networkError(currentUrl, err),
          });
        },
      );
    });

    // Mark "request sent" right before flushing the headers. For a GET
    // with no body, `req.end()` returns immediately after writing the
    // header block to the socket buffer, so the synchronous timestamp
    // is the closest non-platform-specific approximation of "the
    // moment we sent the request."
    requestSentAt = ctx.now();
    req.end();
  });
}

/**
 * Build a Node `lookup` callback that synchronously resolves to
 * `resolvedIp` so the socket connects to the IP the SSRF guard already
 * classified. The callback signature matches `dns.LookupOneOptions`
 * (with `all: false`), the form Node's `http`/`https` modules use by
 * default.
 */
function pinnedLookup(resolvedIp: string, family: 4 | 6) {
  return function lookup(
    _hostname: string,
    _options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void,
  ): void {
    callback(null, resolvedIp, family);
  };
}

/**
 * Collect every `Set-Cookie` line from {@link IncomingHttpHeaders}.
 * Node returns a `string[]` when the header was sent multiple times,
 * which is the common case for cookie-setting endpoints; we normalise
 * the single-string form to a one-element array.
 */
function collectSetCookieValues(headers: IncomingHttpHeaders): string[] {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

/**
 * Pick a single string out of an `IncomingHttpHeaders` value that
 * Node may give us as `string | string[] | undefined`. Returns
 * `undefined` if the header was not sent.
 */
function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return undefined;
}

// ---------------------------------------------------------------------------
// Body streaming + classification
// ---------------------------------------------------------------------------

/**
 * Read up to `maxBytes` from `res`, aborting the underlying request via
 * `controller` once the cap is hit so the socket is freed instead of
 * draining the whole response.
 *
 * Returns the collected `Buffer`, the byte count, and a `truncated`
 * flag. Listener cleanup is handled in `finally` so no event emitter
 * leaks if the caller's body classifier subsequently throws.
 */
function readBody(
  res: IncomingMessage,
  maxBytes: number,
  _controller: AbortController,
): Promise<{ body: Buffer; truncated: boolean; bytesReceived: number }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytesReceived = 0;
    let truncated = false;
    let settled = false;

    const onData = (chunk: Buffer): void => {
      if (settled) return;
      const remaining = maxBytes - bytesReceived;
      if (remaining <= 0) {
        truncated = true;
        bytesReceived = maxBytes;
        cleanup();
        try {
          res.destroy();
        } catch {
          // ignore — we're abandoning the socket deliberately
        }
        settled = true;
        resolve({
          body: Buffer.concat(chunks, bytesReceived),
          truncated,
          bytesReceived,
        });
        return;
      }
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        bytesReceived += remaining;
        truncated = true;
        cleanup();
        try {
          res.destroy();
        } catch {
          // ignore
        }
        settled = true;
        resolve({
          body: Buffer.concat(chunks, bytesReceived),
          truncated,
          bytesReceived,
        });
        return;
      }
      chunks.push(chunk);
      bytesReceived += chunk.byteLength;
    };

    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        body: Buffer.concat(chunks, bytesReceived),
        truncated,
        bytesReceived,
      });
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    function cleanup(): void {
      res.removeListener("data", onData);
      res.removeListener("end", onEnd);
      res.removeListener("error", onError);
    }

    res.on("data", onData);
    res.once("end", onEnd);
    res.once("error", onError);
  });
}

/**
 * Decode the response body bytes into the string surfaced by
 * {@link WebFetchOutcome.body}.
 *
 * Decision matrix:
 *   - `mode = "raw"`            → UTF-8 (replace) up to `maxBytes`
 *                                  (Requirement 2.29).
 *   - `mode = "readable"` AND
 *     content-type is HTML/XHTML → run {@link toReadableText} so chrome
 *                                  and non-rendering content are
 *                                  stripped (Requirements 2.4, 2.28).
 *   - `mode = "readable"` AND
 *     non-HTML text             → UTF-8 (replace) up to `maxBytes`
 *                                  (Requirement 2.5).
 *
 * The `body` arg has already been truncated to `maxBytes` by
 * {@link readBody}, so HTML conversion only ever runs on bytes that
 * are already capped (Property 7).
 */
function classifyAndDecodeBody(input: {
  mode: ResponseMode;
  contentType: string | undefined;
  body: Buffer;
  maxBytes: number;
}): string {
  const decoded = decodeUtf8WithReplacement(input.body);

  if (input.mode === "raw") return decoded;

  if (
    typeof input.contentType === "string" &&
    HTML_CONTENT_TYPE_PATTERN.test(input.contentType)
  ) {
    return toReadableText(decoded);
  }

  return decoded;
}

/**
 * UTF-8 decoder with replacement for invalid byte sequences. Node's
 * built-in `TextDecoder` is the most reliable way to do this without
 * pulling in `iconv-lite`.
 */
function decodeUtf8WithReplacement(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * Render the body preview included in `http-error` outcomes
 * (Requirement 6.4). The preview is decoded as UTF-8 with replacement
 * and capped at {@link HTTP_ERROR_BODY_PREVIEW_BYTES}; when the
 * underlying body was truncated we append the standard truncation
 * marker so the agent can tell it did not see the full response.
 */
function renderBodyPreview(
  body: Buffer,
  truncated: boolean,
  _bytesReceived: number,
): string {
  const text = decodeUtf8WithReplacement(body);
  if (!truncated) return text;
  return `${text}${TRUNCATION_MARKER}`;
}

// ---------------------------------------------------------------------------
// Outcome assembly
// ---------------------------------------------------------------------------

interface BuildSuccessInput {
  args: NormalisedArgs;
  capture: Capture;
  lastUrl: string;
  body: string;
  bytesReceived: number;
  truncated: boolean;
  truncatedAt?: number;
  contentType: string | undefined;
  now: () => number;
  t0: number;
}

/**
 * Compose a successful {@link WebFetchOutcome} from the captured
 * fields, applying redaction and the 64 KiB metadata budget.
 *
 * Implements the design's "Pipeline steps in detail" §11–12: redact
 * before metadata assembly, then run `budget.enforce` so the final
 * `metadata.budget.metadataBytes` reflects the size of the *trimmed*
 * payload.
 */
function buildSuccessOutcome(input: BuildSuccessInput): WebFetchOutcome {
  const totalMs = input.now() - input.t0;
  const captured = input.capture.finalize(totalMs);
  return {
    ok: true,
    metadata: assembleMetadata({
      args: input.args,
      captured,
      requestedUrl: input.args.url,
      finalUrl: input.lastUrl,
      status: captured.status,
      contentType: input.contentType,
      bytesReceived: input.bytesReceived,
      truncated: input.truncated,
      ...(input.truncatedAt !== undefined
        ? { truncatedAt: input.truncatedAt }
        : {}),
    }),
    body: input.body,
  };
}

interface ErrorOutcomeInput {
  requestedUrl: string;
  finalUrl: string;
  mode: ResponseMode;
  capture?: Capture | undefined;
  error: WebFetchError;
  now: () => number;
  t0: number;
  includeHeaders?: boolean | undefined;
  includeTls?: boolean | undefined;
  includeTiming?: boolean | undefined;
  includeRedirectChain?: boolean | undefined;
  redactSensitive?: boolean | undefined;
}

/**
 * Compose an `ok=false` {@link WebFetchOutcome}.
 *
 * The metadata envelope is always populated. Pipeline stages that ran
 * before the failure surface their captured values (e.g. `resolvedIp`
 * after a successful DNS lookup but a `blocked-address` IP); stages
 * that did not run carry default zero/empty values. This keeps the
 * audit-log payload built downstream uniform regardless of where the
 * failure surfaced.
 */
function errorOutcome(input: ErrorOutcomeInput): WebFetchOutcome {
  const totalMs = input.now() - input.t0;
  const captured =
    input.capture !== undefined ? input.capture.finalize(totalMs) : undefined;

  const includeHeaders = input.includeHeaders ?? DEFAULT_INCLUDE_HEADERS;
  const includeTiming = input.includeTiming ?? DEFAULT_INCLUDE_TIMING;
  const includeRedirectChain =
    input.includeRedirectChain ?? DEFAULT_INCLUDE_REDIRECT_CHAIN;
  // For TLS, default to whether the captured fields produced one (which
  // implies the URL was https and the handshake completed).
  const includeTls = input.includeTls ?? captured?.tls !== undefined;
  const redactSensitive = input.redactSensitive ?? DEFAULT_REDACT_SENSITIVE;

  const args: NormalisedArgs = {
    url: input.requestedUrl,
    maxBytes: DEFAULT_MAX_BYTES,
    includeHeaders,
    includeTls,
    includeTiming,
    includeRedirectChain,
    responseMode: input.mode,
    redactSensitive,
  };

  const metadata = captured
    ? assembleMetadata({
        args,
        captured,
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl,
        status: input.error.status ?? captured.status ?? 0,
        contentType: undefined,
        bytesReceived: 0,
        truncated: false,
      })
    : assembleEmptyMetadata({
        args,
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl,
        status: input.error.status ?? 0,
      });

  return {
    ok: false,
    metadata,
    body: "",
    error: input.error,
  };
}

/**
 * Build a {@link WebFetchMetadata} envelope from a {@link CapturedFields}
 * snapshot.
 *
 * Honors the `include*` flags from {@link NormalisedArgs}: setting a
 * flag to `false` strips the corresponding optional field from the
 * envelope (Requirements 2.15–2.18, 2.24). Sensitive headers / cookie
 * values are redacted by `applyToHeaders` / `applyToCookies` before
 * the 64 KiB budget loop runs in {@link enforceBudget}.
 */
function assembleMetadata(input: {
  args: NormalisedArgs;
  captured: CapturedFields;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | undefined;
  bytesReceived: number;
  truncated: boolean;
  truncatedAt?: number;
}): WebFetchMetadata {
  const { args, captured } = input;

  const headersIn = args.includeHeaders ? captured.headers : undefined;
  const cookiesIn = captured.cookies;
  const redactedHeaders =
    headersIn !== undefined
      ? applyToHeaders(headersIn, args.redactSensitive)
      : undefined;
  const redactedCookies = applyToCookies(cookiesIn, args.redactSensitive);

  const tlsIn = args.includeTls ? captured.tls : undefined;
  const timingIn = args.includeTiming ? captured.timing : undefined;
  const redirectChainIn = args.includeRedirectChain
    ? captured.redirectChain
    : undefined;

  const budgeted = enforceBudget({
    ...(redactedHeaders !== undefined ? { headers: redactedHeaders } : {}),
    ...(tlsIn !== undefined ? { tls: tlsIn } : {}),
    ...(timingIn !== undefined ? { timing: timingIn } : {}),
    ...(redirectChainIn !== undefined ? { redirectChain: redirectChainIn } : {}),
    cookies: redactedCookies,
  });

  const meta: WebFetchMetadata = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    resolvedIp: captured.resolvedIp,
    finalHostname: captured.finalHostname,
    mode: args.responseMode,
    bytesReceived: input.bytesReceived,
    truncated: input.truncated,
    budget: { metadataBytes: budgeted.metadataBytes, cap: METADATA_BUDGET_BYTES },
  };
  if (input.contentType !== undefined) meta.contentType = input.contentType;
  if (input.truncatedAt !== undefined) meta.truncatedAt = input.truncatedAt;
  if (budgeted.headers !== undefined) meta.headers = budgeted.headers;
  if (budgeted.tls !== undefined) meta.tls = budgeted.tls;
  if (budgeted.timing !== undefined) meta.timing = budgeted.timing;
  if (budgeted.redirectChain !== undefined)
    meta.redirectChain = budgeted.redirectChain;
  if (budgeted.cookies !== undefined) meta.cookies = budgeted.cookies;
  return meta;
}

/**
 * Build a minimal {@link WebFetchMetadata} envelope for failures that
 * surfaced before any transport-level capture happened (argument
 * validation, blocked scheme on the entry URL, etc.).
 */
function assembleEmptyMetadata(input: {
  args: NormalisedArgs;
  requestedUrl: string;
  finalUrl: string;
  status: number;
}): WebFetchMetadata {
  const emptyTiming: TimingInfo = { dnsMs: 0, tcpMs: 0, ttfbMs: 0, totalMs: 0 };
  const budgeted = enforceBudget({
    ...(input.args.includeHeaders ? { headers: {} as HeaderMap } : {}),
    ...(input.args.includeTiming ? { timing: emptyTiming } : {}),
    ...(input.args.includeRedirectChain
      ? { redirectChain: [] as RedirectChain }
      : {}),
    cookies: [] as CookieInfo[],
  });

  const meta: WebFetchMetadata = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    resolvedIp: "",
    finalHostname: tryHostname(input.finalUrl),
    mode: input.args.responseMode,
    bytesReceived: 0,
    truncated: false,
    budget: { metadataBytes: budgeted.metadataBytes, cap: METADATA_BUDGET_BYTES },
  };
  if (budgeted.headers !== undefined) meta.headers = budgeted.headers;
  if (budgeted.timing !== undefined) meta.timing = budgeted.timing;
  if (budgeted.redirectChain !== undefined)
    meta.redirectChain = budgeted.redirectChain;
  if (budgeted.cookies !== undefined) meta.cookies = budgeted.cookies;
  return meta;
}

/** Best-effort hostname extraction; returns "" for malformed URLs. */
function tryHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Build the `timeout` error from the design's error matrix:
 * "web.fetch: timeout after 30s (last url=…)" carrying the elapsed
 * wall-clock for callers that want to log it (Requirement 2.10).
 */
function timeoutError(
  lastUrl: string,
  t0: number,
  now: () => number,
): WebFetchError {
  const elapsedMs = Math.max(0, now() - t0);
  return {
    kind: "timeout",
    message: `web.fetch: timeout after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s (last url=${lastUrl}, elapsed=${elapsedMs}ms)`,
    url: lastUrl,
  };
}

/**
 * Build the generic `network` error used for DNS / connect / TLS
 * failures (Requirement 6.3 indirectly via the design's error matrix).
 * The optional `prefix` lets callers tag a more specific category
 * (e.g. "DNS resolution failed") in front of the underlying message.
 */
function networkError(
  lastUrl: string,
  err: unknown,
  prefix?: string,
): WebFetchError {
  const detail = err instanceof Error ? err.message : String(err);
  const head = typeof prefix === "string" && prefix.length > 0
    ? `${prefix}: `
    : "";
  return {
    kind: "network",
    message: `web.fetch: ${head}${detail} (url=${lastUrl})`,
    url: lastUrl,
  };
}

// Re-export the discriminated-error union so adapters in 4.x can
// branch on `error.kind` without re-importing from `types.ts`.
export type { WebFetchErrorKind };
