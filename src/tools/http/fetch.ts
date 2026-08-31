import type { ToolResult } from "../../types.js";
import { selectOutput } from "../output-selection.js";
import type { OutputSelection, ResponsePart } from "../output-selection.js";
import { decodeTextBody } from "../web/decode.js";
import { isBlockedAddress } from "../web/ssrf-guard.js";
import { closeAgents, createPinnedAgent, getInsecureTlsAgent } from "./agents.js";
import { formatHttpEvidence, RedirectHop, snapshotHeaders } from "./evidence-format.js";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import net from "node:net";
import { Agent } from "undici";

/** Flatten error + nested cause(s) for TLS code matching. */
function errorText(error: unknown, depth = 0): string {
  if (depth > 4 || error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) {
    const cause = error.cause !== undefined ? errorText(error.cause, depth + 1) : "";
    const code =
      "code" in error && typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code)
        : "";
    return `${error.message} ${code} ${cause}`;
  }
  if (typeof error === "object") {
    const rec = error as Record<string, unknown>;
    const code = typeof rec.code === "string" ? rec.code : "";
    const message = typeof rec.message === "string" ? rec.message : "";
    const cause = rec.cause !== undefined ? errorText(rec.cause, depth + 1) : "";
    try {
      return `${message} ${code} ${cause} ${JSON.stringify(error)}`;
    } catch {
      return `${message} ${code} ${cause}`;
    }
  }
  return String(error);
}

/** True when the error is a TLS hostname/cert mismatch (common for https://IP). */
export function isTlsCertNameError(error: unknown): boolean {
  const text = errorText(error);
  return (
    /ERR_TLS_CERT_ALTNAME_INVALID/i.test(text) ||
    /Hostname\/IP does not match certificate/i.test(text) ||
    /certificate.*altname/i.test(text) ||
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE/i.test(text) ||
    /DEPTH_ZERO_SELF_SIGNED_CERT/i.test(text) ||
    /SELF_SIGNED_CERT/i.test(text) ||
    /unable to verify the first certificate/i.test(text)
  );
}

function formatTlsNetworkError(error: unknown, url: string): string {
  const base = error instanceof Error ? error.message : String(error);
  if (!isTlsCertNameError(error)) return base;
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep raw */
  }
  const byIp = net.isIP(host.replace(/^\[|\]$/g, "")) !== 0;
  return (
    `${base}\n\n` +
    `TLS certificate did not validate for this URL` +
    (byIp
      ? ` (you connected by IP ${host}; the cert is almost always issued for a hostname, not the IP).`
      : `.`) +
    `\nAuthorized testing options:\n` +
    `  1. Retry with the hostname that matches the cert (from SAN/CN), or\n` +
    `  2. http.fetch with insecureTls=true (or tlsInsecure=true) to skip verification and still capture evidence, or\n` +
    `  3. shell: curl -k -i ${url}\n` +
    `Evidence taken with insecureTls is still valid for recon; record that TLS verification was disabled.`
  );
}

/** Capture budget for decoded response-body bytes (artifact + evidence build). */
const DEFAULT_MAX_BYTES = 128 * 1024;

/** Hard memory ceiling for one response capture; raise maxBytes up to this cap. */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

/**
 * Default retries for remote evidence: 0 so intentional 5xx/probe responses are
 * not silently rewritten. Callers may pass retries; owned loopback still soft-
 * retries connection refused.
 */
const DEFAULT_RETRIES = 0;

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

/** Browser-like default UA — less fingerprint noise than clai-http-fetch/*. */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; clai/1.0; +https://github.com/pentoshi007/clai) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 40_000;

const MIN_TIMEOUT_MS = 1_000;

const MAX_TIMEOUT_MS = 1_800_000;

/**
 * Upper bound for policy DNS only — must cover slow / corporate resolvers
 * without hanging forever. Literal IPs skip lookup entirely. The outer
 * request abort (15s) still bounds the whole hop.
 */
const DNS_LOOKUP_TIMEOUT_MS = 10_000;

async function resolveHosts(host: string): Promise<string[]> {
  if (net.isIP(host)) return [host];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("DNS lookup timed out")),
          DNS_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
    return Array.from(new Set(results.map((result) => result.address)));
  } catch {
    // NXDOMAIN, timeout, or resolver failure — treat as unresolved (not blocked
    // by IP class alone; authorizeHop still sees the empty list).
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True for loopback hostnames / IPs (local dev servers). */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    h === "localhost" ||
    h === "localhost.localdomain" ||
    h === "ip6-localhost" ||
    h === "ip6-loopback" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "0:0:0:0:0:0:0:1"
  ) {
    return true;
  }
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

/**
 * Vite/macOS often listens on only one of IPv4/IPv6. Browser "localhost"
 * works dual-stack; a single-address probe can false-fail. Return ordered
 * candidates: original host first, then the other loopback form(s).
 */
export function loopbackUrlCandidates(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [url];
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!isLoopbackHost(host)) return [url];

  const out: string[] = [];
  const push = (hostname: string): void => {
    try {
      const u = new URL(parsed.toString());
      // WHATWG URL: assign bare IPv6 without brackets.
      u.hostname = hostname === "[::1]" ? "::1" : hostname;
      const s = u.toString();
      if (!out.includes(s)) out.push(s);
    } catch {
      /* skip invalid candidate */
    }
  };

  // Prefer the caller's host first (browser-compatible localhost).
  push(host === "[::1]" ? "::1" : host);
  if (host === "localhost" || host === "localhost.localdomain") {
    push("127.0.0.1");
    push("::1");
  } else if (host === "127.0.0.1" || /^127\./.test(host)) {
    push("localhost");
    push("::1");
  } else if (host === "::1" || host === "0:0:0:0:0:0:0:1") {
    push("127.0.0.1");
    push("localhost");
  }
  return out.length > 0 ? out : [url];
}

function isConnectionRefusedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /\bECONNREFUSED\b/i.test(msg) ||
    /\bconnect\s+ECONNREFUSED\b/i.test(msg) ||
    /\bfetch failed\b/i.test(msg) ||
    /\bother side closed\b/i.test(msg) ||
    /\bsocket hang up\b/i.test(msg)
  );
}

interface FetchOptions extends OutputSelection {
  method?: string | undefined;
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  iOwnThis?: boolean | undefined;
  retries?: number | undefined;
  /** Request timeout in ms (clamped 1s–30min). Default 40s. */
  timeoutMs?: number | undefined;
  /** HTML body formatting; raw is the forensic default. */
  responseMode?: "readable" | "raw" | undefined;
  responsePart?: ResponsePart | undefined;
  /**
   * Forward credentials across an origin-changing redirect. Disabled by
   * default so an in-scope endpoint cannot leak supplied auth to another host.
   */
  forwardSensitiveHeaders?: boolean | undefined;
  /**
   * Skip TLS certificate verification (hostname mismatch / self-signed).
   * For authorized pentest against https://IP or lab certs only. Evidence
   * will note that verification was disabled.
   */
  insecureTls?: boolean | undefined;
  signal?: AbortSignal | undefined;
  authorizeHop?: ((url: string, resolvedAddresses: string[]) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }) | undefined;
}

function clampTimeoutMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

export async function httpFetch(
  url: string,
  options: FetchOptions = {},
): Promise<ToolResult> {
  const startedAt = Date.now();
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ok: false, output: `Invalid URL: ${url}`, exitCode: 1 };
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return {
      ok: false,
      output: `Refusing non-http(s) scheme: ${target.protocol}`,
      exitCode: 1,
    };
  }

  const method = (options.method ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return {
      ok: false,
      output: `Unsupported HTTP method: ${method}`,
      exitCode: 1,
    };
  }

  const startHost = target.hostname.replace(/^\[|\]$/g, "");
  const ownedLoopback = Boolean(options.iOwnThis && isLoopbackHost(startHost));
  const authorizedAddresses = new Map<string, string[]>();

  // SSRF and engagement-policy checks run for the initial destination and
  // every redirect hop. Owned loopback (local app verify) skips engagement
  // hop checks — a leftover pentest scope must not block http://localhost:5173.
  const authorizeDestination = async (destination: URL): Promise<string | undefined> => {
    const hostname = destination.hostname.replace(/^\[|\]$/g, "");
    const resolvedAddresses = await resolveHosts(hostname);
    authorizedAddresses.set(hostname.toLowerCase(), resolvedAddresses);
    const blocked = isBlockedAddress(hostname) || resolvedAddresses.some(isBlockedAddress);
    const destLoopback = isLoopbackHost(hostname);
    if (blocked && !options.iOwnThis) {
      return `Refusing to fetch private/loopback/metadata address ${hostname}. Pass iOwnThis=true to override.`;
    }
    // Owned local-dev probes are never subject to remote engagement scope.
    if (options.iOwnThis && destLoopback) {
      return undefined;
    }
    if (options.authorizeHop) {
      const decision = await options.authorizeHop(destination.toString(), resolvedAddresses);
      if (!decision.allowed) return `Blocked network destination ${destination.toString()}: ${decision.reason}`;
    }
    return undefined;
  };
  const initialDenial = await authorizeDestination(target);
  if (initialDenial) return { ok: false, output: initialDenial, exitCode: 1 };

  const headers = new Headers(options.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", DEFAULT_USER_AGENT);
  }
  if (!headers.has("accept")) {
    headers.set(
      "accept",
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    );
  }
  if (!headers.has("accept-language")) {
    headers.set("accept-language", "en-US,en;q=0.8");
  }

  const insecureTls = Boolean(options.insecureTls);
  const init: RequestInit & { dispatcher?: Agent } = {
    method,
    headers,
    redirect: "manual",
  };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = options.body;
  }
  // The insecure dispatcher is selected per hop below because redirects may
  // change scheme. A single shared dispatcher keeps authorized lab probes
  // cheap without weakening unrelated requests.

  // Local dev: try localhost / 127.0.0.1 / ::1 until one accepts (Vite dual-stack).
  const urlCandidates =
    ownedLoopback && (method === "GET" || method === "HEAD")
      ? loopbackUrlCandidates(url)
      : [url];

  let response: Response | undefined;
  const pinnedAgents: Agent[] = [];
  let attempts = 0;
  let lastNetworkError: unknown;
  // The active URL may advance through redirects within this attempt.
  let usedUrl = url;
  let finalMethod = method;
  let redirectHops: RedirectHop[] = [];
  let responseCleanup: (() => void) | undefined;
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
  // Status retries only when caller opts in (default 0). Loopback keeps soft
  // connection-refused retries below regardless of status-retry budget.
  const statusRetryLimit =
    method === "GET" || method === "HEAD"
      ? clampRetries(options.retries ?? DEFAULT_RETRIES)
      : 0;
  const connRetryLimit = ownedLoopback
    ? Math.max(statusRetryLimit, 4)
    : statusRetryLimit;

  try {
    candidateLoop: for (let ci = 0; ci < urlCandidates.length; ci += 1) {
      const candidateUrl = urlCandidates[ci]!;
      usedUrl = candidateUrl;
      let localAttempts = 0;
      for (;;) {
        attempts += 1;
        localAttempts += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const onParentAbort = () => controller.abort();
        const cleanupAttempt = (): void => {
          clearTimeout(timer);
          if (options.signal) {
            options.signal.removeEventListener("abort", onParentAbort);
          }
        };
        let retainForBody = false;
        if (options.signal) {
          if (options.signal.aborted) {
            throw options.signal.reason ?? new Error("Aborted");
          }
          options.signal.addEventListener("abort", onParentAbort);
        }
        try {
          let requestUrl = candidateUrl;
          let requestMethod = method;
          let requestBody = init.body;
          let requestHeaders = new Headers(headers);
          let redirects = 0;
          redirectHops = [];
          for (;;) {
            const hopInit: RequestInit & { dispatcher?: Agent } = {
              ...init,
              method: requestMethod,
              headers: requestHeaders,
              signal: controller.signal,
            };
            if (requestBody === undefined || requestBody === null) {
              delete hopInit.body;
            } else {
              hopInit.body = requestBody;
            }
            const hopUrl = new URL(requestUrl);
            const hopHost = hopUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
            const pinned = authorizedAddresses.get(hopHost) ?? [];
            if (!isLoopbackHost(hopHost)) {
              const dispatcher = createPinnedAgent(
                pinned,
                insecureTls && hopUrl.protocol === "https:",
                options.iOwnThis === true,
              );
              pinnedAgents.push(dispatcher);
              hopInit.dispatcher = dispatcher;
            } else if (insecureTls && hopUrl.protocol === "https:") {
              // Owned loopback keeps the shared dispatcher so localhost can
              // retain its IPv4/IPv6 fallback behavior.
              hopInit.dispatcher = getInsecureTlsAgent();
            } else {
              delete hopInit.dispatcher;
            }

            usedUrl = requestUrl;
            response = await fetch(requestUrl, hopInit);
            finalMethod = requestMethod;
            const location = response.headers.get("location");
            if (!(response.status >= 300 && response.status < 400 && location)) break;
            if (redirects >= 10) throw new Error("Too many redirects (maximum 10)");
            redirectHops.push({
              status: response.status,
              statusText: response.statusText,
              method: requestMethod,
              url: requestUrl,
              location,
              headers: snapshotHeaders(response.headers),
            });
            const next = new URL(location, requestUrl);
            const denial = await authorizeDestination(next);
            if (denial) throw new Error(denial);

            if (
              !options.forwardSensitiveHeaders &&
              new URL(requestUrl).origin !== next.origin
            ) {
              requestHeaders = new Headers(requestHeaders);
              requestHeaders.delete("authorization");
              requestHeaders.delete("proxy-authorization");
              requestHeaders.delete("cookie");
            }

            // Match widely deployed user-agent redirect semantics while
            // preserving methods for 307/308. This avoids replaying a POST
            // body onto a 303 destination and records the actual method used.
            if (
              requestMethod !== "HEAD" &&
              (response.status === 303 ||
                ((response.status === 301 || response.status === 302) &&
                  requestMethod === "POST"))
            ) {
              requestMethod = "GET";
              requestBody = undefined;
              requestHeaders = new Headers(requestHeaders);
              requestHeaders.delete("content-length");
              requestHeaders.delete("content-type");
              requestHeaders.delete("transfer-encoding");
            }

            await drainResponse(response);
            requestUrl = next.toString();
            redirects += 1;
          }
          if (
            localAttempts <= statusRetryLimit &&
            RETRY_STATUSES.has(response.status)
          ) {
            await drainResponse(response);
            await sleep(retryDelayMs(localAttempts));
            continue;
          }
          retainForBody = true;
          responseCleanup = cleanupAttempt;
          break candidateLoop;
        } catch (error) {
          lastNetworkError = error;
          const isTimeout =
            error instanceof Error &&
            error.name === "AbortError" &&
            !options.signal?.aborted;
          const errMsg = isTimeout
            ? `Request timed out after ${timeoutMs}ms`
            : error instanceof Error
              ? error.message
              : String(error);
          if (options.signal?.aborted) {
            throw new Error(errMsg);
          }
          // Connection refused on loopback → try next address or retry.
          if (ownedLoopback && isConnectionRefusedError(error)) {
            if (localAttempts <= connRetryLimit) {
              await sleep(Math.min(400 * localAttempts, 1500));
              continue;
            }
            if (ci + 1 < urlCandidates.length) {
              break; // next candidate
            }
            throw new Error(errMsg);
          }
          if (localAttempts > statusRetryLimit) {
            throw new Error(errMsg);
          }
          await sleep(retryDelayMs(localAttempts));
        } finally {
          if (!retainForBody) cleanupAttempt();
        }
      }
    }
  } catch (error) {
    await closeAgents(pinnedAgents);
    const tried =
      urlCandidates.length > 1
        ? ` (tried ${urlCandidates.join(" → ")})`
        : "";
    const detail = formatTlsNetworkError(error, usedUrl || url);
    return {
      ok: false,
      output: `Network error after ${attempts} attempt${attempts === 1 ? "" : "s"}${tried}: ${detail}`,
      exitCode: 1,
    };
  }
  if (!response) {
    await closeAgents(pinnedAgents);
    return {
      ok: false,
      output: "Network error: no response was received",
      exitCode: 1,
    };
  }
  const limit = clampCaptureBytes(options.maxBytes);
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let truncated = false;
  let bodyReadError: unknown;
  try {
    const reader = response.body?.getReader();
    if (reader && options.responsePart === "headers") {
      // Headers-only callers do not need to buffer or decode the body.
      try {
        await reader.cancel();
      } catch {
        // The response metadata is still valid if cancellation races socket close.
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    } else if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const remaining = limit - bytesRead;
          if (remaining <= 0) {
            truncated = true;
            try {
              await reader.cancel();
            } catch {
              // ignore — we're abandoning the body deliberately
            }
            break;
          }
          const captured = value.byteLength > remaining
            ? value.subarray(0, remaining)
            : value;
          chunks.push(Buffer.from(captured));
          bytesRead += captured.byteLength;
          if (value.byteLength > remaining) {
            truncated = true;
            try {
              await reader.cancel();
            } catch {
              // ignore — we're abandoning the body deliberately
            }
            break;
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // already released
        }
      }
    }
  } catch (error) {
    bodyReadError = error;
  } finally {
    responseCleanup?.();
    responseCleanup = undefined;
  }
  if (bodyReadError !== undefined) {
    const timedOut =
      bodyReadError instanceof Error &&
      bodyReadError.name === "AbortError" &&
      !options.signal?.aborted;
    await closeAgents(pinnedAgents);
    return {
      ok: false,
      output: timedOut
        ? `Request timed out after ${timeoutMs}ms while reading response body`
        : `Response body read failed: ${bodyReadError instanceof Error ? bodyReadError.message : String(bodyReadError)}`,
      exitCode: timedOut ? 124 : options.signal?.aborted ? 130 : 1,
    };
  }

  const capturedBody = Buffer.concat(chunks, bytesRead);
  const contentType = response.headers.get("content-type") ?? "";
  const decoded = decodeTextBody(capturedBody, contentType);
  const isBinary =
    isBinaryContentType(contentType) ||
    (!isTextualContentType(contentType) && isBinaryContent(capturedBody));
  const finalUrl = response.url || usedUrl;
  const evidence = formatHttpEvidence({
    requestedMethod: method,
    finalMethod,
    requestedUrl: url,
    usedUrl,
    finalUrl,
    status: response.status,
    statusText: response.statusText,
    attempts,
    bytesRead,
    bodySha256: createHash("sha256").update(capturedBody).digest("hex"),
    bodyCharset: decoded.charset,
    charsetSource: decoded.charsetSource,
    unsupportedCharset: decoded.unsupportedCharset,
    truncated,
    limit,
    contentType,
    headers: response.headers,
    body: decoded.text,
    isBinary,
    redirectHops,
    lastNetworkError,
    insecureTls,
    forwardSensitiveHeaders: options.forwardSensitiveHeaders === true,
    responseMode: options.responseMode ?? "raw",
    responsePart: options.responsePart ?? "full",
  });
  const output = selectOutput(evidence, options);
  await closeAgents(pinnedAgents);

  return {
    ok: true,
    output,
    exitCode: 0,
    truncated: truncated || output !== evidence,
    stats: {
      bytesRead,
      bytesDropped: 0,
      linesRead: decoded.text.split("\n").length,
      elapsedMs: Date.now() - startedAt,
    },
  };
}

function clampCaptureBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_BYTES;
  return Math.max(0, Math.min(MAX_CAPTURE_BYTES, Math.floor(value)));
}

function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RETRIES;
  return Math.max(0, Math.min(5, Math.floor(value)));
}

function retryDelayMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(0, attempt - 1), 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best effort only; redirect/retry can proceed after a socket-close race.
  }
}

function isBinaryContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().trim();
  if (ct.includes("image/svg+xml")) return false; // SVGs are xml text
  if (
    ct.startsWith("image/") ||
    ct.startsWith("video/") ||
    ct.startsWith("audio/") ||
    ct.startsWith("application/octet-stream") ||
    ct.startsWith("application/zip") ||
    ct.startsWith("application/pdf") ||
    ct.startsWith("application/x-")
  ) {
    return true;
  }
  return false;
}

function isTextualContentType(contentType: string): boolean {
  const ct = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  return (
    ct.startsWith("text/") ||
    ct === "image/svg+xml" ||
    ct === "application/json" ||
    ct.endsWith("+json") ||
    ct === "application/xml" ||
    ct.endsWith("+xml") ||
    ct === "application/javascript" ||
    ct === "application/x-javascript" ||
    ct === "application/x-www-form-urlencoded"
  );
}

function isBinaryContent(body: Buffer): boolean {
  const sample = body.subarray(0, 2_048);
  let nonPrintableCount = 0;
  for (const byte of sample) {
    if (byte === 0) return true;
    // Control bytes other than tab (9), lf (10), cr (13).
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintableCount += 1;
      if (nonPrintableCount > 5) return true;
    }
  }
  return false;
}
