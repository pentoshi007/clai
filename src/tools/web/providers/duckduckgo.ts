/**
 * DuckDuckGo search-provider adapter.
 *
 * Used as the keyless default so `clai` works out of the box without
 * any API key (Requirement 3.5). The adapter targets DuckDuckGo's
 * lite-HTML endpoint at `https://html.duckduckgo.com/html/?q=…`,
 * parses the response with `cheerio`, unwraps the in-page redirect
 * shim (`/l/?uddg=<encoded>`) so callers see the destination URL, and
 * applies the same URL filter `web.search` enforces (Requirement 7.3)
 * before forwarding hits to the registry handler.
 *
 * The adapter does not need redirect-chain capture, fine-grained
 * timing, TLS metadata, or DNS-rebinding protection beyond the
 * per-invocation `AbortSignal`, so it deliberately bypasses the full
 * `fetch-core` pipeline. A small `node:https.request`-based helper
 * keeps the implementation simple while still honoring the 15-second
 * `web.search` invocation timeout (Requirement 1.8) via the supplied
 * `AbortSignal`.
 *
 * Per Requirement 6.7 the adapter issues exactly one outbound request
 * per invocation and never retries on transient failure.
 */

import { Buffer } from "node:buffer";
import https from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";

import * as cheerio from "cheerio";

import type { RawProviderResponse, SearchProvider } from "./provider.js";
import { searchProviders } from "./provider.js";

/** Endpoint for DuckDuckGo's keyless lite-HTML search. */
const ENDPOINT = "https://html.duckduckgo.com/html/";

/**
 * User-Agent sent on the outbound DDG request.
 *
 * DuckDuckGo's html/lite endpoints anti-bot-challenge obvious
 * non-browser agents (replying HTTP 202 with a non-results page), so
 * we present a current desktop-browser UA to reduce the challenge rate.
 * Note this is best-effort: DDG also throttles by source IP, so on a
 * blocked network a keyed provider (Brave / Tavily) is the reliable
 * path.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * Inject point for the underlying HTTPS transport. Mirrors the seam in
 * `./brave.ts` so unit tests can drive the adapter without touching the
 * network. Production code never invokes the setter.
 */
type HttpsRequestFn = typeof https.request;

let httpsRequestFn: HttpsRequestFn = https.request;

/**
 * Test-only seam: swap the HTTPS transport used by the adapter. Tests use
 * this to inject a stubbed `request` implementation that emits scripted
 * responses; production callers never invoke it.
 */
export function __setDuckduckgoHttpsRequestForTesting(
  fn: HttpsRequestFn | undefined,
): void {
  httpsRequestFn = fn ?? https.request;
}

/**
 * Cap on the bytes read from DDG's lite-HTML response. The page is
 * typically well under 200 KiB; the cap exists purely as a memory
 * guard so a misbehaving server cannot stream us an unbounded body.
 */
const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Result of {@link httpsGetText}: the response status code and body
 * decoded as UTF-8 (replacement for invalid sequences). The body is
 * truncated at {@link MAX_RESPONSE_BYTES}.
 */
interface FetchedHtml {
  status: number;
  body: string;
}

/**
 * Issue a single GET request over HTTPS, honoring the supplied
 * abort signal (which `web.search` arms to a 15-second timer).
 *
 * Reads at most {@link MAX_RESPONSE_BYTES}, decodes as UTF-8 with
 * replacement of invalid sequences, and resolves with `{status, body}`.
 * Network failures and aborts surface as a rejected promise so the
 * registry handler can map them to the appropriate
 * `WebSearchErrorKind`.
 *
 * Redirect-chain capture is intentionally omitted here — DDG's lite
 * endpoint replies 200 directly in normal operation, and any 3xx is
 * treated as an empty result by the caller.
 */
function httpsGetText(url: string, signal: AbortSignal): Promise<FetchedHtml> {
  return new Promise<FetchedHtml>((resolve, reject) => {
    let req: ClientRequest;
    try {
      req = httpsRequestFn(
        url,
        {
          method: "GET",
          signal,
          headers: {
            "user-agent": USER_AGENT,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "en-US,en;q=0.9",
            "accept-encoding": "identity",
          },
        },
        (res: IncomingMessage) => {
          const status =
            typeof res.statusCode === "number" ? res.statusCode : 0;
          const chunks: Buffer[] = [];
          let received = 0;
          let stopped = false;

          const stop = (): void => {
            if (stopped) return;
            stopped = true;
            try {
              res.destroy();
            } catch {
              // ignore — we are abandoning the socket deliberately
            }
          };

          res.on("data", (chunk: Buffer) => {
            if (stopped) return;
            const remaining = MAX_RESPONSE_BYTES - received;
            if (remaining <= 0) {
              stop();
              return;
            }
            if (chunk.byteLength > remaining) {
              chunks.push(chunk.subarray(0, remaining));
              received += remaining;
              stop();
              return;
            }
            chunks.push(chunk);
            received += chunk.byteLength;
          });

          res.once("end", () => {
            const body = Buffer.concat(chunks, received).toString("utf-8");
            resolve({ status, body });
          });

          res.once("close", () => {
            // If the body was truncated by `stop()`, `end` does not
            // fire — resolve from `close` so the promise still
            // settles.
            if (stopped) {
              const body = Buffer.concat(chunks, received).toString("utf-8");
              resolve({ status, body });
            }
          });

          res.once("error", (err) => {
            reject(err);
          });
        },
      );
    } catch (err) {
      reject(err);
      return;
    }

    req.once("error", (err: Error) => {
      reject(err);
    });

    req.end();
  });
}

/**
 * Disallowed character class for hit URLs (Requirement 7.3): any
 * whitespace or ASCII control character. The handler in `web.search`
 * applies the same filter, so dropping here is purely an early exit.
 */
const URL_INVALID_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

/**
 * Validate a candidate hit URL against the rules `web.search` enforces:
 * non-empty string, parseable as an absolute URL, scheme `http:` or
 * `https:`, no whitespace, no ASCII control characters.
 */
function isValidHitUrl(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (URL_INVALID_CHARS_RE.test(raw)) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Strip DuckDuckGo's in-page redirect wrapper so the destination URL
 * is what callers see.
 *
 * DDG renders result links as `/l/?uddg=<percent-encoded destination>`
 * (sometimes with extra tracking parameters). For non-wrapper links —
 * e.g. ad placements that point directly at an external URL — the
 * input is returned as an absolute URL unchanged.
 *
 * Returns `undefined` when the input is empty, fails URL parsing, or
 * is a `/l/` wrapper without a usable `uddg` parameter.
 */
function unwrapDdgRedirect(href: string): string | undefined {
  if (typeof href !== "string" || href.length === 0) return undefined;
  let parsed: URL;
  try {
    // Resolve protocol-relative (`//duckduckgo.com/l/…`) and absolute
    // path (`/l/…`) forms against the DDG endpoint so URL parsing
    // succeeds for every shape DDG emits.
    parsed = new URL(href, ENDPOINT);
  } catch {
    return undefined;
  }
  if (parsed.pathname === "/l/" && parsed.searchParams.has("uddg")) {
    const destination = parsed.searchParams.get("uddg") ?? "";
    if (destination.length === 0) return undefined;
    return destination;
  }
  return parsed.toString();
}

/**
 * The DuckDuckGo {@link SearchProvider} adapter.
 *
 * Resolves a search query into a {@link RawProviderResponse} carrying
 * up to `maxResults` `{title, url, snippet}` hits. URL filtering and
 * `maxResults` truncation happen here so the registry handler does not
 * have to re-walk the cheerio tree; the handler still re-applies the
 * filter for defense in depth (Requirement 7.3).
 */
export const duckduckgoProvider: SearchProvider = {
  id: "duckduckgo",
  displayName: "DuckDuckGo",
  needsApiKey: false,
  async search(
    query: string,
    maxResults: number,
    _auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse> {
    const url = `${ENDPOINT}?q=${encodeURIComponent(query)}`;

    const { status, body } = await httpsGetText(url, signal);

    // Non-2xx responses surface to the handler with an empty hit
    // list; the handler maps the status to the right
    // `WebSearchErrorKind` (auth/rate-limit/server/http) per
    // Requirements 6.1, 6.2, 6.6, and 1.9.
    if (status < 200 || status >= 300) {
      return { status, hits: [] };
    }

    let $: cheerio.CheerioAPI;
    try {
      $ = cheerio.load(body);
    } catch (err) {
      return {
        status,
        hits: [],
        parseError: err instanceof Error ? err.message : String(err),
      };
    }

    const hits: Array<{ title?: string; url?: string; snippet?: string }> = [];

    $(".result").each((_idx, el) => {
      if (hits.length >= maxResults) return false;

      const titleAnchor = $(el).find(".result__title a").first();
      const titleText = titleAnchor.text().trim();
      const href = titleAnchor.attr("href") ?? "";
      const destination = unwrapDdgRedirect(href);

      // Drop hits whose URL is missing/invalid before they count
      // toward `maxResults` (Requirement 7.3).
      if (destination === undefined || !isValidHitUrl(destination)) return;

      const snippet = $(el).find(".result__snippet").first().text().trim();
      hits.push({ title: titleText, url: destination, snippet });
      return;
    });

    return { status, hits };
  },
};

// Register the adapter in the shared registry so the `web.search`
// handler can dispatch through it once `activeSearchProvider` is set
// to `"duckduckgo"`.
searchProviders.duckduckgo = duckduckgoProvider;
