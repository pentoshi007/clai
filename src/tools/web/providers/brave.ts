/**
 * Brave Search adapter for `web.search`.
 *
 * Implements the {@link SearchProvider} contract from `./provider.ts` and
 * registers itself in the {@link searchProviders} registry on import. The
 * adapter performs exactly one outbound HTTPS request per invocation
 * (Requirement 6.7), forwards the caller-provided {@link AbortSignal} to
 * the underlying transport so the 15-second `web.search` timeout is
 * honored (Requirement 1.8), and returns a {@link RawProviderResponse}
 * describing the HTTP outcome plus the raw hit list.
 *
 * Status-to-error-kind classification (`401/403 → auth`, `429 → rate-limit`,
 * `5xx → server`, non-JSON → `parse`, other non-2xx → `http`) is the
 * responsibility of the `web.search` handler; this adapter only exposes
 * the raw HTTP `status` and the parsed (or `parseError`-flagged) hit list
 * so that mapping can be applied uniformly across providers (Requirements
 * 6.1, 6.2, 6.5, 6.6).
 *
 * Endpoint and request shape match the design's "Per-provider notes →
 * Brave Search" section (`.kiro/specs/web-search-and-fetch/design.md`).
 */

import https from "node:https";
import type { IncomingMessage } from "node:http";

import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Brave Search Web API endpoint (host + path). */
const BRAVE_HOST = "api.search.brave.com";
const BRAVE_PATH = "/res/v1/web/search";

/**
 * `count` parameter accepted by the Brave Web Search API. The provider's
 * documented range is 1..20, which already matches the `maxResults`
 * clamp the `web.search` handler enforces, so we forward the value
 * unchanged but defend against out-of-range inputs that might slip past
 * the handler in tests.
 */
const BRAVE_MIN_COUNT = 1;
const BRAVE_MAX_COUNT = 20;

/** User-Agent sent on outbound Brave requests. */
const DEFAULT_USER_AGENT = "clai-web-search/1.0";

/**
 * Hard cap on the number of body bytes we read from the provider before
 * giving up and surfacing a `parse` error. Brave responses for 20 hits
 * are well under 100 KiB; this cap is defensive against a misbehaving
 * upstream that streams an unbounded body.
 */
const MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Inject point for the underlying HTTPS transport so unit/property tests
 * in epic 7.x can drive the adapter without touching the network. The
 * default mirrors the standard `node:https.request` signature.
 *
 * Kept module-private (not exported) because the public adapter contract
 * intentionally takes no transport argument — `web.search` always uses
 * the default transport in production.
 */
type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

/**
 * Test-only seam: swap the HTTPS transport used by the adapter.
 * Production callers never invoke this; tests in 7.x use it to inject a
 * stubbed `request` implementation that emits scripted responses.
 */
export function __setBraveHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

/**
 * Clamp `count` to the Brave-supported range. The handler is expected to
 * pass an already-clamped value, but defending here keeps the adapter
 * self-consistent if invoked directly (e.g. from a test).
 */
function clampCount(count: number): number {
  if (!Number.isFinite(count)) return BRAVE_MIN_COUNT;
  const rounded = Math.trunc(count);
  if (rounded < BRAVE_MIN_COUNT) return BRAVE_MIN_COUNT;
  if (rounded > BRAVE_MAX_COUNT) return BRAVE_MAX_COUNT;
  return rounded;
}

/**
 * Drain `res` into a UTF-8 string, capped at {@link MAX_RESPONSE_BYTES}.
 * The body cap defends against a misbehaving upstream; the
 * {@link AbortSignal} short-circuits the read on `web.search`'s 15-second
 * timeout (Requirement 1.8).
 */
function readBody(res: IncomingMessage, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      res.destroy(new Error("aborted"));
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("aborted"),
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    res.on("data", (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        aborted = true;
        signal.removeEventListener("abort", onAbort);
        res.destroy();
        reject(new Error("response body exceeded 1 MiB cap"));
        return;
      }
      chunks.push(chunk);
    });
    res.on("end", () => {
      if (aborted) return;
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    res.on("error", (err) => {
      if (aborted) return;
      aborted = true;
      signal.removeEventListener("abort", onAbort);
      reject(err);
    });
  });
}

/**
 * Issue the Brave HTTP GET and return `{status, body}` once the response
 * is fully read. Network failures (DNS, connect, TLS, socket reset)
 * propagate as a thrown error so the adapter can map them to
 * `RawProviderResponse` with a `status: 0` placeholder for the search
 * handler's `network` classification (Requirement 6.3).
 */
function dispatchRequest(
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<{ status: number; body: string }> {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("count", String(count));
  const path = `${BRAVE_PATH}?${params.toString()}`;

  return new Promise((resolve, reject) => {
    const req = httpsRequestFn(
      {
        method: "GET",
        host: BRAVE_HOST,
        path,
        signal,
        headers: {
          accept: "application/json",
          "user-agent": DEFAULT_USER_AGENT,
          // Brave Search expects the key in this exact header
          // (case-insensitive per HTTP, but we use the canonical casing
          // from Brave's published examples for clarity in audit logs).
          "X-Subscription-Token": apiKey,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        readBody(res, signal).then(
          (body) => resolve({ status, body }),
          (err) => reject(err),
        );
      },
    );

    req.on("error", (err) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Extract the Brave `web.results[]` array from a parsed JSON body and map
 * it to the {@link RawProviderResponse.hits} shape. Each hit contributes
 * `title`/`url`/`description` (Brave's snippet field) verbatim; the
 * `web.search` handler is responsible for further validation (URL
 * shape, whitespace, control chars — Requirement 7.3).
 *
 * Returns `null` when the JSON body did not have the expected
 * `{ web: { results: [...] } }` shape, signalling the adapter to surface
 * a `parseError` so the handler can emit `error.kind="parse"`
 * (Requirement 6.5).
 */
function extractHits(
  parsed: unknown,
): RawProviderResponse["hits"] | null {
  if (!parsed || typeof parsed !== "object") return null;
  const web = (parsed as { web?: unknown }).web;
  if (!web || typeof web !== "object") return null;
  const results = (web as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;

  const hits: RawProviderResponse["hits"] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      title?: unknown;
      url?: unknown;
      description?: unknown;
    };
    const hit: RawProviderResponse["hits"][number] = {};
    if (typeof e.title === "string") hit.title = e.title;
    if (typeof e.url === "string") hit.url = e.url;
    if (typeof e.description === "string") hit.snippet = e.description;
    hits.push(hit);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

/**
 * Brave Search adapter. Registered in {@link searchProviders} as a
 * side-effect of importing this module — `web.search` resolves the active
 * provider via the registry.
 */
export const braveProvider: SearchProvider = {
  id: "brave",
  displayName: "Brave Search",
  needsApiKey: true,
  envVar: "BRAVE_SEARCH_API_KEY",

  async search(
    query: string,
    maxResults: number,
    auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    // Defensive: the handler resolves the key before calling us. If
    // somehow we're invoked without one, surface a 0-status response so
    // the handler can map it to `missing-key` / `network` rather than
    // dispatching an unauthenticated request to Brave.
    if (!auth.apiKey) {
      return {
        status: 0,
        hits: [],
        parseError: "missing api key",
      };
    }

    const count = clampCount(maxResults);
    const { status, body } = await dispatchRequest(
      query,
      count,
      auth.apiKey,
      signal,
    );

    // Non-2xx: forward the status with an empty hit list. The search
    // handler maps the status to the appropriate error kind
    // (`auth` for 401/403, `rate-limit` for 429, `server` for 5xx,
    // `http` for everything else).
    if (status < 200 || status >= 300) {
      return { status, hits: [] };
    }

    // 2xx: parse JSON. Anything that does not parse, or whose shape
    // does not match `{ web: { results: [...] } }`, surfaces as
    // `parseError` so the handler emits `error.kind="parse"`
    // (Requirement 6.5).
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return {
        status,
        hits: [],
        parseError:
          err instanceof Error
            ? `non-JSON response: ${err.message}`
            : "non-JSON response",
      };
    }

    const hits = extractHits(parsed);
    if (hits === null) {
      return {
        status,
        hits: [],
        parseError: "missing web.results array in Brave response",
      };
    }

    return { status, hits };
  },
};

// Register on import so `searchProviders.brave` is populated by the time
// the `web.search` handler dispatches.
searchProviders.brave = braveProvider;
