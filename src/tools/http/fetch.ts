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
import { DEFAULT_RETRIES, RETRY_STATUSES, clampCaptureBytes, clampRetries, clampTimeoutMs, drainResponse, formatTlsNetworkError, isBinaryContent, isBinaryContentType, isConnectionRefusedError, isTextualContentType, retryDelayMs, sleep } from "./retry-policy.js";
export { isTlsCertNameError } from "./retry-policy.js";

const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; clai/1.0; +https://github.com/pentoshi007/clai) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

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
    return [];
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  return false;
}

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
      u.hostname = hostname === "[::1]" ? "::1" : hostname;
      const s = u.toString();
      if (!out.includes(s)) out.push(s);
    } catch {
    }
  };

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

interface FetchOptions extends OutputSelection {
  method?: string | undefined;
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  iOwnThis?: boolean | undefined;
  retries?: number | undefined;
  timeoutMs?: number | undefined;
  responseMode?: "readable" | "raw" | undefined;
  responsePart?: ResponsePart | undefined;
  /**
   * Forward credentials across an origin-changing redirect. Disabled by
   * default so an in-scope endpoint cannot leak supplied auth to another host.
   */
  forwardSensitiveHeaders?: boolean | undefined;
  insecureTls?: boolean | undefined;
  signal?: AbortSignal | undefined;
  authorizeHop?: ((url: string, resolvedAddresses: string[]) => Promise<{ allowed: boolean; reason: string }> | { allowed: boolean; reason: string }) | undefined;
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
  const authorizeDestination = async (destination: URL): Promise<string | undefined> => {
    const hostname = destination.hostname.replace(/^\[|\]$/g, "");
    const resolvedAddresses = await resolveHosts(hostname);
    authorizedAddresses.set(hostname.toLowerCase(), resolvedAddresses);
    const blocked = isBlockedAddress(hostname) || resolvedAddresses.some(isBlockedAddress);
    const destLoopback = isLoopbackHost(hostname);
    if (blocked && !options.iOwnThis) {
      return `Refusing to fetch private/loopback/metadata address ${hostname}. Pass iOwnThis=true to override.`;
    }
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

  const urlCandidates =
    ownedLoopback && (method === "GET" || method === "HEAD")
      ? loopbackUrlCandidates(url)
      : [url];

  let response: Response | undefined;
  const pinnedAgents: Agent[] = [];
  let attempts = 0;
  let lastNetworkError: unknown;
  let usedUrl = url;
  let finalMethod = method;
  let redirectHops: RedirectHop[] = [];
  let responseCleanup: (() => void) | undefined;
  const timeoutMs = clampTimeoutMs(options.timeoutMs);
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
          if (ownedLoopback && isConnectionRefusedError(error)) {
            if (localAttempts <= connRetryLimit) {
              await sleep(Math.min(400 * localAttempts, 1500));
              continue;
            }
            if (ci + 1 < urlCandidates.length) {
              break;
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
      try {
        await reader.cancel();
      } catch {
      } finally {
        try {
          reader.releaseLock();
        } catch {
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
            }
            break;
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
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

