// Feature: web-search-and-fetch, Property 2: web.search input validation
//
// Validates: Requirements 1.1, 1.2, 1.5, 1.6
//
// For arbitrary `(query, maxResults)` argument pairs, `webSearch`
// returns `ok=true` exactly when `trim(query).length ∈ [1, 400]` and
// `maxResults` is `undefined` or an integer in `[1, 20]`; otherwise
// `ok=false` with an error message naming the offending argument and
// the violated rule.
//
// We drive `webSearch` with an injected provider override so no real
// network I/O happens. The override returns a single canned hit so the
// `ok=true` branch deterministically yields a non-empty result.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { webSearch } from "../../src/tools/web/search.js";
import {
  MAX_MAX_RESULTS,
  MAX_QUERY_LENGTH,
  MIN_MAX_RESULTS,
  MIN_QUERY_LENGTH,
} from "../../src/tools/web/types.js";
import type { SearchProvider } from "../../src/tools/web/providers/provider.js";

const PROVIDER_OVERRIDE: SearchProvider = {
  id: "duckduckgo",
  displayName: "DuckDuckGo",
  needsApiKey: false,
  async search() {
    return {
      status: 200,
      hits: [
        {
          title: "stub",
          url: "https://example.com/stub",
          snippet: "ok",
        },
      ],
    };
  },
};

interface ArgsTuple {
  query: unknown;
  maxResults?: unknown;
}

function isValidArgs(args: ArgsTuple): boolean {
  if (typeof args.query !== "string") return false;
  const trimmedLen = args.query.trim().length;
  if (trimmedLen < MIN_QUERY_LENGTH || trimmedLen > MAX_QUERY_LENGTH) {
    return false;
  }
  if (args.maxResults === undefined) return true;
  if (typeof args.maxResults !== "number") return false;
  if (!Number.isInteger(args.maxResults)) return false;
  if (args.maxResults < MIN_MAX_RESULTS || args.maxResults > MAX_MAX_RESULTS) {
    return false;
  }
  return true;
}

const queryArb = fc.oneof(
  // valid in-range strings
  fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length >= 1),
  // empty / all-whitespace
  fc.constantFrom("", " ", "\t", "   "),
  // exact lower/upper boundary
  fc.constant("a"),
  fc.string({ minLength: MAX_QUERY_LENGTH, maxLength: MAX_QUERY_LENGTH }),
  // overlength
  fc.string({ minLength: MAX_QUERY_LENGTH + 1, maxLength: MAX_QUERY_LENGTH + 50 }),
  // non-string
  fc.constantFrom(undefined, null, 42, true),
);

const maxResultsArb = fc.oneof(
  fc.constant(undefined),
  fc.integer({ min: 1, max: 20 }),
  fc.integer({ min: -10, max: 0 }),
  fc.integer({ min: 21, max: 100 }),
  fc.double({ min: 0.5, max: 19.5 }).filter((n) => !Number.isInteger(n)),
  fc.constantFrom("5", null, true),
);

describe("Property 2: web.search input validation", () => {
  it("ok=true ⇔ query+maxResults satisfy declared types and ranges", async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, maxResultsArb, async (query, maxResults) => {
        const args = { query, ...(maxResults === undefined ? {} : { maxResults }) };
        // Cast through `unknown` because fast-check intentionally
        // generates non-string queries to exercise the validation
        // surface.
        const result = await webSearch(args as never, {
          providerOverride: PROVIDER_OVERRIDE,
        });

        const expectOk = isValidArgs(args);
        if (expectOk) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          // Error message must mention the offending argument.
          const offendingIsQuery =
            typeof query !== "string" ||
            query.trim().length < MIN_QUERY_LENGTH ||
            query.trim().length > MAX_QUERY_LENGTH;
          if (offendingIsQuery) {
            expect(result.output.toLowerCase()).toContain("query");
          } else {
            expect(result.output.toLowerCase()).toContain("maxresults");
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
