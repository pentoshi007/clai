// Unit tests for the DuckDuckGo `SearchProvider` adapter.
//
// These tests stub the HTTPS transport via the test seam exposed in
// `src/tools/web/providers/duckduckgo.ts` so no network I/O happens. They
// assert:
//
//   1. Lite-HTML parsing extracts the expected `{title, url, snippet}` hits
//      from `.result__title a` / `.result__snippet`.
//   2. DuckDuckGo's in-page redirect wrapper (`/l/?uddg=…`) is unwrapped so
//      the destination URL — not the wrapper — appears in the result.
//   3. Hits whose URL is empty, missing a scheme, non-http(s), or contains
//      whitespace / ASCII control characters are dropped (Requirement 7.3),
//      and dropped hits do NOT count toward `maxResults`.
//   4. Non-2xx HTTP responses surface with `hits=[]` and the upstream status
//      so the `web.search` handler can map them to the right error kind.
//   5. The provider is registered in the shared `searchProviders` registry
//      under the `"duckduckgo"` id, with `needsApiKey=false` and no `envVar`.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setDuckduckgoHttpsRequestForTesting,
  duckduckgoProvider,
} from "../../../src/tools/web/providers/duckduckgo.js";
import { searchProviders } from "../../../src/tools/web/providers/provider.js";

// ---------------------------------------------------------------------------
// HTTPS transport stub
// ---------------------------------------------------------------------------

/** Signature mirrored from `node:https.request`. */
type HttpsRequestFn = typeof import("node:https").request;

/**
 * Build a fake `https.request` that emits one synthetic response with the
 * given status code and body. The fake captures the requested URL into
 * `state.lastUrl` and counts how many times `request()` was invoked into
 * `state.callCount` so callers can assert the single-attempt invariant
 * (Requirement 6.7).
 */
function makeStubTransport(
  status: number,
  body: string,
): { fn: HttpsRequestFn; state: { callCount: number; lastUrl?: string } } {
  const state: { callCount: number; lastUrl?: string } = { callCount: 0 };

  const fn: HttpsRequestFn = ((
    urlOrOptions: unknown,
    optionsOrCb?: unknown,
    maybeCb?: unknown,
  ): ClientRequest => {
    state.callCount += 1;

    // The adapter calls `httpsRequestFn(url, options, cb)` with all three
    // positional arguments populated, so the callback is in the third slot.
    if (typeof urlOrOptions === "string") {
      state.lastUrl = urlOrOptions;
    } else if (urlOrOptions instanceof URL) {
      state.lastUrl = urlOrOptions.toString();
    }

    const cb =
      typeof maybeCb === "function"
        ? (maybeCb as (res: IncomingMessage) => void)
        : typeof optionsOrCb === "function"
          ? (optionsOrCb as (res: IncomingMessage) => void)
          : undefined;

    const req = new EventEmitter() as unknown as ClientRequest;
    // The adapter only calls `req.end()` after registering listeners; the
    // EventEmitter shape is enough for the rest of the request lifecycle.
    (req as unknown as { end: () => void }).end = () => {};

    // Drive the response on `setImmediate` so the adapter's synchronous
    // `req.once("error", ...)` listener registration completes first.
    setImmediate(() => {
      if (!cb) return;
      const res = new EventEmitter() as unknown as IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = status;
      cb(res);

      setImmediate(() => {
        const buf = Buffer.from(body, "utf-8");
        (res as unknown as EventEmitter).emit("data", buf);
        (res as unknown as EventEmitter).emit("end");
      });
    });

    return req;
  }) as HttpsRequestFn;

  return { fn, state };
}

// ---------------------------------------------------------------------------
// HTML fixtures
// ---------------------------------------------------------------------------

/**
 * Three-result lite-HTML fixture. Two hits use the DDG `/l/?uddg=…`
 * redirect wrapper; one hit (third) is an absolute external URL the way DDG
 * sometimes renders ad placements. This drives both the wrapper-stripping
 * path and the absolute-URL passthrough path of `unwrapDdgRedirect`.
 */
const FIXTURE_THREE_RESULTS = `
<html><body>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fpage-one">
      Example One
    </a>
  </h2>
  <a class="result__snippet" href="#">
    Snippet for the first result, just some text.
  </a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.org%2Fpath%3Fa%3D1">
      Example Two
    </a>
  </h2>
  <a class="result__snippet" href="#">Second snippet.</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="https://example.net/direct">Example Three Direct</a>
  </h2>
  <a class="result__snippet" href="#">Third snippet.</a>
</div>
</body></html>
`;

/**
 * Fixture exercising every URL-rejection branch of Requirement 7.3:
 *
 *   1. Empty `uddg` (drops because the wrapper has no destination).
 *   2. `javascript:` scheme (rejected because the destination is non-http).
 *   3. URL with whitespace inside the destination.
 *   4. URL with an embedded ASCII control character (\u0001).
 *   5. A valid hit that should survive and become the only kept result.
 *
 * The first four hits MUST NOT consume `maxResults` slots (Requirement
 * 7.3 — filtered hits do not count toward the cap).
 */
const FIXTURE_INVALID_URLS = `
<html><body>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=">Empty redirect</a>
  </h2>
  <a class="result__snippet" href="#">drop empty</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=javascript%3Aalert(1)">Js scheme</a>
  </h2>
  <a class="result__snippet" href="#">drop scheme</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fbad.example%2Fwith%20space">Whitespace</a>
  </h2>
  <a class="result__snippet" href="#">drop whitespace</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fbad.example%2Fctl%01">Control char</a>
  </h2>
  <a class="result__snippet" href="#">drop control</a>
</div>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fgood.example%2Fkept">Survivor</a>
  </h2>
  <a class="result__snippet" href="#">kept</a>
</div>
</body></html>
`;

// ---------------------------------------------------------------------------
// Test fixtures and lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  // Reset the transport seam so a stubbed request does not leak into
  // subsequent tests (or into the production `https.request` defaults).
  __setDuckduckgoHttpsRequestForTesting(undefined);
});

/** Convenience: an already-aborted-friendly signal that never aborts. */
function neverAbortSignal(): AbortSignal {
  return new AbortController().signal;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("duckduckgoProvider", () => {
  it("registers itself in the shared searchProviders registry", () => {
    // The provider module side-effect-registers on import; assert the
    // registry entry matches the exported instance and carries the
    // expected metadata (id, displayName, no API key required, no env var).
    expect(searchProviders.duckduckgo).toBe(duckduckgoProvider);
    expect(duckduckgoProvider.id).toBe("duckduckgo");
    expect(duckduckgoProvider.needsApiKey).toBe(false);
    expect(duckduckgoProvider.envVar).toBeUndefined();
  });

  it("parses lite-HTML hits and unwraps the /l/?uddg= redirect", async () => {
    const { fn, state } = makeStubTransport(200, FIXTURE_THREE_RESULTS);
    __setDuckduckgoHttpsRequestForTesting(fn);

    const response = await duckduckgoProvider.search(
      "hello world",
      5,
      {},
      neverAbortSignal(),
    );

    // Single outbound attempt (Requirement 6.7), with the URL-encoded query.
    expect(state.callCount).toBe(1);
    expect(state.lastUrl).toBe(
      "https://html.duckduckgo.com/html/?q=hello%20world",
    );

    expect(response.status).toBe(200);
    expect(response.parseError).toBeUndefined();
    expect(response.hits).toEqual([
      {
        title: "Example One",
        url: "https://example.com/page-one",
        snippet: "Snippet for the first result, just some text.",
      },
      {
        title: "Example Two",
        url: "https://example.org/path?a=1",
        snippet: "Second snippet.",
      },
      {
        title: "Example Three Direct",
        url: "https://example.net/direct",
        snippet: "Third snippet.",
      },
    ]);
  });

  it("drops hits with empty / non-http(s) / whitespace / control-char URLs and does not count them toward maxResults", async () => {
    const { fn } = makeStubTransport(200, FIXTURE_INVALID_URLS);
    __setDuckduckgoHttpsRequestForTesting(fn);

    // Five candidate hits in the fixture, four should be filtered, one
    // should survive. Asking for `maxResults=2` proves filtered hits do
    // not eat into the budget — we still get the survivor back.
    const response = await duckduckgoProvider.search(
      "ddg",
      2,
      {},
      neverAbortSignal(),
    );

    expect(response.status).toBe(200);
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.url).toBe("https://good.example/kept");
    expect(response.hits[0]?.title).toBe("Survivor");
  });

  it("respects maxResults by stopping at the requested count", async () => {
    const { fn } = makeStubTransport(200, FIXTURE_THREE_RESULTS);
    __setDuckduckgoHttpsRequestForTesting(fn);

    const response = await duckduckgoProvider.search(
      "hello",
      2,
      {},
      neverAbortSignal(),
    );

    expect(response.status).toBe(200);
    expect(response.hits).toHaveLength(2);
    expect(response.hits.map((h) => h.url)).toEqual([
      "https://example.com/page-one",
      "https://example.org/path?a=1",
    ]);
  });

  it("returns the upstream status and an empty hit list on non-2xx", async () => {
    const { fn } = makeStubTransport(503, "<html><body>Service Unavailable</body></html>");
    __setDuckduckgoHttpsRequestForTesting(fn);

    const response = await duckduckgoProvider.search(
      "anything",
      5,
      {},
      neverAbortSignal(),
    );

    // Non-2xx responses surface to the handler with status + empty hits;
    // the handler is responsible for mapping the status to the right
    // `WebSearchErrorKind` (server / auth / rate-limit / http).
    expect(response.status).toBe(503);
    expect(response.hits).toEqual([]);
    expect(response.parseError).toBeUndefined();
  });
});
