import { Capture } from "./capture.js";
import { decodeContentEncoding } from "./content-encoding.js";
import { decodeTextBody } from "./decode.js";
import { toReadableText } from "./readable.js";
import { classify as classifyIp, classifyHost, isAllowedScheme } from "./ssrf-guard.js";
import { HTTP_ERROR_BODY_PREVIEW_BYTES, MAX_REDIRECT_HOPS, TRUNCATION_MARKER } from "./types.js";
import type { ResponseMode, ResponsePart, WebFetchError } from "./types.js";
import { Buffer } from "node:buffer";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as defaultDnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

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

/**
 * Argument bundle with every optional field resolved to a concrete
 * default per `types.ts`. Downstream code reads only this shape so the
 * defaults are not re-derived in multiple places.
 */
export interface NormalisedArgs {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  includeHeaders: boolean;
  includeTls: boolean;
  includeTiming: boolean;
  includeRedirectChain: boolean;
  responseMode: ResponseMode;
  responsePart: ResponsePart;
  redactSensitive: boolean;
}

/**
 * Best-effort extraction of the scheme prefix for a URL string that may
 * not parse cleanly. Used only inside `blocked-scheme` error messages.
 */
export function schemeOf(raw: string): string {
  const m = raw.match(/^([a-z][a-z0-9+.\-]*):/i);
  return m && typeof m[1] === "string" ? `${m[1]}:` : raw;
}

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
export async function runRequestLoop(
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

      // HTTP error (Requirement 6.4). Headers-only callers do not need a
      // body preview; body/full callers receive up to 4 KiB.
      if (status >= 400 && status < 600) {
        if (ctx.args.responsePart === "headers") {
          res.destroy();
          finish({
            kind: "error",
            error: {
              kind: "http-error",
              message: `${status} ${currentUrl}`,
              status,
              url: currentUrl,
            },
          });
          return;
        }
        readBody(res, HTTP_ERROR_BODY_PREVIEW_BYTES, ctx.controller).then(
          ({ body, truncated, bytesReceived }) => {
            let preview = renderBodyPreview(
              body,
              truncated,
              bytesReceived,
              contentType,
            );
            if (
              ctx.args.responseMode === "readable" &&
              typeof contentType === "string" &&
              HTML_CONTENT_TYPE_PATTERN.test(contentType)
            ) {
              const readable = toReadableText(
                decodeTextBody(body, contentType).text,
                currentUrl,
              );
              if (readable) {
                preview = renderBodyPreview(
                  Buffer.from(readable, "utf8"),
                  truncated,
                  bytesReceived,
                  "text/plain; charset=utf-8",
                );
              }
            }
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

      // Successful (2xx or non-Location 3xx) terminal hop. Headers-only
      // requests can stop immediately instead of buffering a body they will
      // discard in the adapter.
      if (ctx.args.responsePart === "headers") {
        res.destroy();
        finish({
          kind: "terminal",
          status,
          contentType,
          body: "",
          bytesReceived: 0,
          truncated: false,
        });
        return;
      }
      readBody(res, ctx.args.maxBytes, ctx.controller).then(
        ({ body, truncated, bytesReceived }) => {
          const text = classifyAndDecodeBody({
            mode: ctx.args.responseMode,
            contentType,
            body,
            maxBytes: ctx.args.maxBytes,
            baseUrl: currentUrl,
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
 * classified.
 *
 * The callback must honor the `all` option. Node's `http`/`https` agents
 * call `lookup` with `all: false` and expect the one-result form
 * `(err, address, family)`. Bun's agent instead calls `lookup` with
 * `{ all: true }` and expects the array form `(err, [{ address, family }])`;
 * it then runs `results.sort((a, b) => b.family - a.family)` on whatever is
 * passed back. Returning a bare string there throws
 * "results.sort is not a function" and breaks every fetch under the
 * Bun-compiled binary, so we branch on the requested form. The `options`
 * argument may also be the callback itself when Node invokes the
 * `lookup(hostname, callback)` overload.
 */
function pinnedLookup(resolvedIp: string, family: 4 | 6) {
  return function lookup(
    _hostname: string,
    options: LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void {
    const wantsAll =
      typeof options === "object" && options !== null && options.all === true;

    if (wantsAll) {
      callback(null, [{ address: resolvedIp, family }]);
    } else {
      callback(null, resolvedIp, family);
    }
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

/**
 * Read up to `maxBytes` from `res`, aborting the underlying request via
 * `controller` once the cap is hit so the socket is freed instead of
 * draining the whole response.
 *
 * Returns the collected `Buffer`, the byte count, and a `truncated`
 * flag. Listener cleanup is handled in `finally` so no event emitter
 * leaks if the caller's body classifier subsequently throws.
 */
function contentEncodingHeader(res: IncomingMessage): string | undefined {
  const raw = res.headers["content-encoding"];
  if (Array.isArray(raw)) return raw.join(", ");
  return typeof raw === "string" ? raw : undefined;
}

function readBody(
  res: IncomingMessage,
  maxBytes: number,
  controller: AbortController,
): Promise<{ body: Buffer; truncated: boolean; bytesReceived: number }> {
  return readRawBody(res, maxBytes, controller).then((raw) => {
    const decoded = decodeContentEncoding(raw.body, contentEncodingHeader(res));
    if (decoded.applied.length === 0) return raw;
    if (decoded.body.byteLength <= maxBytes) {
      return { ...raw, body: decoded.body };
    }
    return {
      body: decoded.body.subarray(0, maxBytes),
      truncated: true,
      bytesReceived: raw.bytesReceived,
    };
  });
}

function readRawBody(
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
 *   - `mode = "raw"`            → decode using the declared Content-Type
 *                                  charset (or HTML meta / UTF-8 fallback),
 *                                  up to `maxBytes`.
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
  baseUrl?: string;
}): string {
  const decoded = decodeTextBody(input.body, input.contentType).text;

  if (input.mode === "raw") return decoded;

  if (
    typeof input.contentType === "string" &&
    HTML_CONTENT_TYPE_PATTERN.test(input.contentType)
  ) {
    return toReadableText(decoded, input.baseUrl);
  }

  return decoded;
}

/**
 * Render the body preview included in `http-error` outcomes
 * (Requirement 6.4). The preview honors the response charset and is capped at
 * {@link HTTP_ERROR_BODY_PREVIEW_BYTES}; when the underlying body was
 * truncated we append the standard truncation marker so the agent can tell it
 * did not see the full response.
 */
function renderBodyPreview(
  body: Buffer,
  truncated: boolean,
  _bytesReceived: number,
  contentType?: string,
): string {
  const text = decodeTextBody(body, contentType).text;
  if (!truncated) return text;
  return `${text}${TRUNCATION_MARKER}`;
}

/**
 * Build the `timeout` error from the design's error matrix:
 * "web.fetch: timeout after Ns (last url=…)" carrying the elapsed
 * wall-clock for callers that want to log it (Requirement 2.10).
 */
export function timeoutError(
  lastUrl: string,
  t0: number,
  now: () => number,
): WebFetchError {
  const elapsedMs = Math.max(0, now() - t0);
  return {
    kind: "timeout",
    message: `web.fetch: timeout after ${Math.round(elapsedMs / 1000)}s (last url=${lastUrl}, elapsed=${elapsedMs}ms)`,
    url: lastUrl,
  };
}

/**
 * Build the generic `network` error used for DNS / connect / TLS
 * failures (Requirement 6.3 indirectly via the design's error matrix).
 * The optional `prefix` lets callers tag a more specific category
 * (e.g. "DNS resolution failed") in front of the underlying message.
 */
export function networkError(
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
