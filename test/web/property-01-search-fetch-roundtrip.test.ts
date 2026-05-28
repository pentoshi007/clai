// Feature: web-search-and-fetch, Property 1: Search→fetch URL round-trip
//
// Validates: Requirements 4.6, 7.1, 7.2, 7.3, 7.4
//
// For arbitrary provider raw responses (valid + malformed), every
// `SearchResult` emitted by `webSearch` must be accepted by `webFetch`
// for syntactic URL validation purposes. We stub the provider so the
// upstream "raw hits" arbitrary covers schemes, whitespace, control
// chars, and well-formed URLs uniformly; we stub the fetch transport
// so no real network I/O happens. The property that must hold is:
//
//   for every hit r in webSearch(...).results,
//     webFetch({url: r.url}, ...) does NOT return a syntactic
//     "validation" error from the URL-parsing branch.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { webSearch } from "../../src/tools/web/search.js";
import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import type {
  RawProviderResponse,
  SearchProvider,
} from "../../src/tools/web/providers/provider.js";

const PROVIDER_ID = "duckduckgo" as const;

function makeProviderOverride(raw: RawProviderResponse): SearchProvider {
  return {
    id: PROVIDER_ID,
    displayName: "DuckDuckGo",
    needsApiKey: false,
    async search(): Promise<RawProviderResponse> {
      return raw;
    },
  };
}

/**
 * Stub DNS lookup that always blocks: the test only cares about
 * *syntactic* validation, so we never need to reach the network. If
 * the URL passed validation, `webFetchCore` will surface a typed
 * "blocked-address" or "network" error rather than a "validation"
 * one.
 */
const dnsLookup = async (
  _host: string,
  _o: unknown,
): Promise<{ address: string; family: number }> => ({
  address: "127.0.0.1",
  family: 4,
});

const httpsRequest = (() => {
  // Never reached when SSRF blocks 127.0.0.1, but provide a no-op
  // implementation just in case.
  const fn = (() => {
    const req = new (require("node:events").EventEmitter)();
    req.end = () => {
      queueMicrotask(() => req.emit("error", new Error("transport not used")));
    };
    return req;
  }) as unknown as Parameters<typeof webFetchCore>[1]["httpsRequest"];
  return fn;
})();

const hitArb = fc.record({
  title: fc.option(fc.string(), { nil: undefined }),
  url: fc.option(
    fc.oneof(
      fc.webUrl({ withFragments: true, withQueryParameters: true }),
      // malformed shapes: empty, schemeless, non-http, whitespace,
      // control chars, embedded newlines, and outright garbage
      fc.string(),
      fc.constantFrom(
        "",
        "ftp://example.com/x",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "  https://example.com/  ",
        "https://example.com/path with spaces",
        "data:text/plain,hello",
      ),
    ),
    { nil: undefined },
  ),
  snippet: fc.option(fc.string(), { nil: undefined }),
});

describe("Property 1: search→fetch URL round-trip", () => {
  it("every emitted SearchResult.url passes web.fetch's syntactic URL check", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(hitArb, { minLength: 0, maxLength: 8 }),
        fc.integer({ min: 1, max: 20 }),
        async (rawHits, maxResults) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const provider = makeProviderOverride({ status: 200, hits: rawHits as any });
          const search = await webSearch(
            { query: "round-trip", maxResults },
            { providerOverride: provider },
          );
          // Search must not surface a syntactic-validation error for
          // its own arguments (we passed valid `query` and `maxResults`).
          expect(search.ok).toBe(true);

          // Extract the JSON `results` block — empty searches return
          // the literal "No results found." string with no JSON.
          if (search.output === "No results found.") return;

          const lines = search.output.split("\n\n");
          const json = lines.slice(1).join("\n\n");
          const parsed = JSON.parse(json) as {
            results: Array<{ title: string; url: string; snippet: string }>;
          };

          for (const hit of parsed.results) {
            // Drive the fetch core; its argument validator runs
            // synchronously before any I/O, so even if the stubbed
            // transport would error out later, a "validation" error
            // would surface immediately.
            const outcome = await webFetchCore(
              { url: hit.url, includeTls: false, includeTiming: false, includeRedirectChain: false, includeHeaders: false },
              {
                httpsRequest: httpsRequest!,
                httpRequest: httpsRequest!,
                dnsLookup,
              },
            );
            // Either ok=true OR ok=false with an error.kind that is NOT
            // "validation" / "blocked-scheme" — those are the
            // syntactic-rejection branches the round-trip is supposed
            // to make impossible.
            if (!outcome.ok) {
              expect(outcome.error?.kind).not.toBe("validation");
              expect(outcome.error?.kind).not.toBe("blocked-scheme");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
