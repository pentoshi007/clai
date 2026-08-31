import { Capture } from "./capture.js";
import { decodeContentEncoding } from "./content-encoding.js";
import { decodeTextBody } from "./decode.js";
import { toReadableText } from "./readable.js";
import { HTTP_ERROR_BODY_PREVIEW_BYTES, TRUNCATION_MARKER } from "./types.js";
import type { ResponseMode, ResponsePart, WebFetchError } from "./types.js";
import { Buffer } from "node:buffer";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as defaultDnsLookup } from "node:dns/promises";
import type { ClientRequest, IncomingHttpHeaders, IncomingMessage, RequestOptions } from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

export type DnsLookupFn = typeof defaultDnsLookup;

export type HttpRequestFn = (
  url: string | URL,
  options: RequestOptions,
  callback?: (res: IncomingMessage) => void,
) => ClientRequest;

export type HttpsRequestFn = HttpRequestFn;

const BINARY_CONTENT_TYPE_PATTERNS: readonly RegExp[] = [
  /^image\//i,
  /^application\/octet-stream/i,
  /^application\/pdf/i,
  /^video\//i,
];

const HTML_CONTENT_TYPE_PATTERN = /^(text\/html|application\/xhtml\+xml)/i;

const DEFAULT_USER_AGENT = "clai-web-fetch/1.0";

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([
  301, 302, 303, 307, 308,
]);

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

export interface RequestLoopContext {
  args: NormalisedArgs;
  capture: Capture;
  controller: AbortController;
  now: () => number;
  t0: number;
  httpsRequestFn: HttpsRequestFn;
  httpRequestFn: HttpRequestFn;
  dnsLookupFn: DnsLookupFn;
}

interface IssueHopArgs {
  ctx: RequestLoopContext;
  currentUrl: string;
  parsed: URL;
  resolvedIp: string;
  resolvedFamily: 4 | 6;
  hop: number;
}

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

export async function issueHop(input: IssueHopArgs): Promise<HopOutcome> {
  const { ctx, currentUrl, parsed, resolvedIp, resolvedFamily } = input;
  const isHttps = parsed.protocol === "https:";
  const requestFn = isHttps ? ctx.httpsRequestFn : ctx.httpRequestFn;
  const dnsEndedAt = ctx.now();

  const requestOptions: RequestOptions = {
    method: "GET",
    signal: ctx.controller.signal,
    headers: {
      "user-agent": DEFAULT_USER_AGENT,
      accept: "*/*",
      "accept-encoding": "identity",
      host: parsed.host,
    },
    // request's socket connects to the exact address the SSRF guard
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

      socket.once("connect", () => {
        connectAt = ctx.now();
        const tcpMs = connectAt - dnsEndedAt;
        ctx.capture.markTcpConnected(tcpMs);
      });
      if (isHttps) {
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

      const setCookieValues = collectSetCookieValues(headers);
      for (const value of setCookieValues) {
        ctx.capture.addSetCookieHeader(value);
      }

      const contentType = headerString(headers["content-type"]);

      if (status >= 300 && status < 400 && REDIRECT_STATUSES.has(status)) {
        const location = headerString(headers["location"]);
        if (typeof location === "string" && location.length > 0) {
          res.resume();
          finish({ kind: "redirect", status, location });
          return;
        }
      }

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

function collectSetCookieValues(headers: IncomingHttpHeaders): string[] {
  const value = headers["set-cookie"];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  if (typeof value === "string") return [value];
  return [];
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(", ");
  return undefined;
}

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
