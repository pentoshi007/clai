
import { classify as classifyIp, classifyHost, isAllowedScheme } from "./ssrf-guard.js";
import { MAX_REDIRECT_HOPS } from "./types.js";
import type { WebFetchError } from "./types.js";
import { RequestLoopContext, issueHop, networkError } from "./issue-hop.js";
export { timeoutError } from "./issue-hop.js";
export { networkError };
export type { DnsLookupFn, HttpRequestFn, HttpsRequestFn, NormalisedArgs } from "./issue-hop.js";

/**
 * Best-effort extraction of the scheme prefix for a URL string that may
 * not parse cleanly. Used only inside `blocked-scheme` error messages.
 */
export function schemeOf(raw: string): string {
  const m = raw.match(/^([a-z][a-z0-9+.\-]*):/i);
  return m && typeof m[1] === "string" ? `${m[1]}:` : raw;
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

