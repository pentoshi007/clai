import net from "node:net";
import { lookup } from "node:dns/promises";
import type { ToolResult } from "../types.js";

const DEFAULT_MAX_BYTES = 256 * 1024;
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
 * This stops the agent from being tricked into SSRF against the host's
 * intranet via a "fetch this URL" prompt.
 */
function isBlockedAddress(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower === "localhost.localdomain") return true;
  if (lower === "ip6-localhost" || lower === "ip6-loopback") return true;
  if (net.isIPv4(host)) {
    const parts = host.split(".").map((p) => Number(p));
    const [a, b] = parts;
    if (a === 127) return true; // loopback
    if (a === 10) return true; // RFC1918
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(host)) {
    if (lower === "::1") return true;
    if (lower.startsWith("fe80:")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // ULA
    if (lower.startsWith("::ffff:")) {
      // IPv4-mapped IPv6 — re-check the embedded v4 address.
      const v4 = lower.slice("::ffff:".length);
      return isBlockedAddress(v4);
    }
    return false;
  }
  return false;
}

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

  const init: RequestInit = { method };
  if (options.body !== undefined && method !== "GET" && method !== "HEAD") {
    init.body = options.body;
  }
  if (options.headers) {
    init.headers = options.headers;
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    return {
      ok: false,
      output: `Network error: ${error instanceof Error ? error.message : String(error)}`,
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

  return {
    ok: response.ok,
    output: `${response.status} ${response.statusText} ${response.url}\n${headerBlock}${body}${truncNote}`,
    exitCode: response.status,
    truncated,
  };
}
