import net from "node:net";
import { lookup } from "node:dns/promises";
import type { ToolResult } from "../types.js";
import { isBlockedAddress } from "./web/ssrf-guard.js";
import { toReadableText } from "./web/readable.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_RETRIES = 2;
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

/**
 * Block (or require explicit ownership confirmation for) requests that
 * target loopback, private, link-local, or cloud-metadata addresses.
 *
 * The classification logic now lives in {@link "./web/ssrf-guard"} so that
 * `http.fetch` and the new `web.fetch` tool share a single source of truth
 * for SSRF rules. This file re-exports `isBlockedAddress` for callers that
 * still import it from `../tools/http`, but the implementation is the
 * structured classifier in `web/ssrf-guard.ts`.
 */
export { isBlockedAddress };

async function resolveHost(host: string): Promise<string | undefined> {
  if (net.isIP(host)) return host;
  try {
    const result = await lookup(host);
    return result.address;
  } catch {
    return undefined;
  }
}

interface FetchOptions {
  method?: string | undefined;
  body?: string | undefined;
  headers?: Record<string, string> | undefined;
  maxBytes?: number | undefined;
  iOwnThis?: boolean | undefined;
  retries?: number | undefined;
}

export async function httpFetch(
  url: string,
  options: FetchOptions = {},
): Promise<ToolResult> {
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

  // SSRF guard: refuse loopback/private/link-local/metadata destinations
  // unless the caller explicitly attested ownership of the target.
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const literalBlocked = isBlockedAddress(hostname);
  let resolvedBlocked = false;
  if (!literalBlocked) {
    const resolved = await resolveHost(hostname);
    resolvedBlocked = Boolean(resolved && isBlockedAddress(resolved));
  }
  if ((literalBlocked || resolvedBlocked) && !options.iOwnThis) {
    return {
      ok: false,
      output: `Refusing to fetch private/loopback/metadata address ${hostname}. Pass iOwnThis=true to override.`,
      exitCode: 1,
    };
  }

  const headers = new Headers(options.headers);
  if (!headers.has("user-agent")) {
    headers.set("user-agent", "clai-http-fetch/1.1");
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

  const init: RequestInit = {
    method,
    headers,
    redirect: "follow",
  };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = options.body;
  }

  let response: Response | undefined;
  let attempts = 0;
  let lastNetworkError: unknown;
  const retryLimit =
    method === "GET" || method === "HEAD"
      ? clampRetries(options.retries ?? DEFAULT_RETRIES)
      : 0;
  try {
    for (;;) {
      attempts += 1;
      try {
        response = await fetch(url, init);
        if (
          attempts <= retryLimit &&
          RETRY_STATUSES.has(response.status)
        ) {
          await drainResponse(response);
          await sleep(retryDelayMs(attempts));
          continue;
        }
        break;
      } catch (error) {
        lastNetworkError = error;
        if (attempts > retryLimit) throw error;
        await sleep(retryDelayMs(attempts));
      }
    }
  } catch (error) {
    return {
      ok: false,
      output: `Network error after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode: 1,
    };
  }
  if (!response) {
    return {
      ok: false,
      output: "Network error: no response was received",
      exitCode: 1,
    };
  }

  const limit = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";
  let bytesRead = 0;
  let truncated = false;
  const reader = response.body?.getReader();
  if (reader) {
    try {
      while (bytesRead < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = limit - bytesRead;
        if (value.byteLength > remaining) {
          collected += decoder.decode(value.subarray(0, remaining), { stream: true });
          bytesRead += remaining;
          truncated = true;
          try {
            await reader.cancel();
          } catch {
            // ignore — we're abandoning the body deliberately
          }
          break;
        }
        collected += decoder.decode(value, { stream: true });
        bytesRead += value.byteLength;
      }
      collected += decoder.decode();
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // already released
      }
    }
  } else {
    // No streaming body (eg HEAD or empty 204). Fall through with empty text.
    collected = "";
  }

  const headerLines: string[] = [];
  response.headers.forEach((v, k) => headerLines.push(`${k}: ${v}`));
  const headerBlock = headerLines.length > 0 ? `Headers:\n${headerLines.join("\n")}\n\n` : "";
  const truncNote = truncated
    ? `\n... (truncated at ${limit.toLocaleString()} bytes)`
    : "";
  const body = method === "HEAD" ? "" : collected;
  const contentType = response.headers.get("content-type") ?? "";
  const readable =
    method !== "HEAD" && contentType.toLowerCase().includes("html")
      ? toReadableText(body)
      : "";
  const meta = {
    requestedUrl: url,
    finalUrl: response.url || url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    method,
    attempts,
    retried: attempts > 1,
    headers: Object.fromEntries(
      [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
    contentType,
    bytesRead,
    truncated,
    truncatedAt: truncated ? limit : undefined,
    lastNetworkError:
      lastNetworkError instanceof Error
        ? lastNetworkError.message
        : lastNetworkError
          ? String(lastNetworkError)
          : undefined,
  };
  const evidence = [
    `${response.status} ${response.statusText} ${response.url || url}`,
    `attempts=${attempts} bytes=${bytesRead}${truncated ? ` truncated@${limit}` : ""}`,
    "",
    "Metadata:",
    JSON.stringify(meta, null, 2),
    "",
    headerBlock.trimEnd(),
    readable ? `\nReadable content:\n${readable}\n` : "",
    method === "HEAD" ? "" : `Raw body:\n${body}${truncNote}`,
  ]
    .filter((part) => part !== "")
    .join("\n");

  return {
    ok: true,
    output: evidence,
    exitCode: 0,
    truncated,
  };
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
    await response.arrayBuffer();
  } catch {
    // Best effort only; retrying is more important than draining.
  }
}
