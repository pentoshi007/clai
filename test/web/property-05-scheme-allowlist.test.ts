// Feature: web-search-and-fetch, Property 5: Scheme allowlist
//
// For arbitrary URL strings whose schemes are drawn from a fixed mix of
// {http, https, ftp, file, data, javascript, gopher, "" } plus malformed
// inputs, the `ssrf-guard.isAllowedScheme` helper must classify a URL as
// "allowed" iff its scheme parses as `http:` or `https:`.
//
// Validates: Requirements 5.4, 2.1

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { isAllowedScheme } from "../../src/tools/web/ssrf-guard.js";

/**
 * The full set of schemes we want to exercise. The plan calls out exactly
 * this set; keeping it in one place makes the property's intent explicit.
 */
const SCHEME_POOL = [
  "http",
  "https",
  "ftp",
  "file",
  "data",
  "javascript",
  "gopher",
  "",
] as const;

/**
 * Hostnames we want to exercise. We keep them syntactically valid so that
 * `new URL()` will succeed for the "well-formed URL with scheme X" branch
 * — we want the property to test the *scheme* decision, not URL parsing
 * failures (those are covered separately by the `malformed` branch below).
 */
const hostArb = fc.oneof(
  fc.constant("example.com"),
  fc.constant("sub.example.org"),
  fc.constant("127.0.0.1"),
  fc.constant("192.168.1.1"),
  fc.constant("localhost"),
  fc.constant("[::1]"),
);

/**
 * A path/query suffix appended after the authority. Kept simple so the
 * resulting URL stays parseable; the only thing under test here is the
 * scheme, not encoding edge cases.
 */
const suffixArb = fc.oneof(
  fc.constant(""),
  fc.constant("/"),
  fc.constant("/path"),
  fc.constant("/a/b?c=1"),
  fc.constant("/x#frag"),
);

/**
 * Build a "well-formed" URL string for the given scheme. For the schemes
 * that have an authority component (http, https, ftp, file, gopher) we
 * emit `<scheme>://<host><suffix>`. For `data:` and `javascript:` we emit
 * the canonical opaque form. For the empty scheme we emit a plain path
 * (which `new URL()` rejects unless given a base, so it represents a
 * "missing scheme" case).
 */
function buildUrlArb() {
  return fc
    .tuple(fc.constantFrom(...SCHEME_POOL), hostArb, suffixArb)
    .map(([scheme, host, suffix]) => {
      if (scheme === "") {
        // No scheme at all — should be rejected.
        return `//${host}${suffix}`;
      }
      if (scheme === "data") {
        return "data:text/plain;base64,SGVsbG8sIFdvcmxkIQ==";
      }
      if (scheme === "javascript") {
        return "javascript:alert(1)";
      }
      if (scheme === "file") {
        // file:// URLs accept an empty host per RFC 8089; also try the
        // hosted form so both shapes are exercised.
        return `${scheme}://${suffix.length > 0 ? suffix : "/etc/passwd"}`;
      }
      return `${scheme}://${host}${suffix}`;
    });
}

/**
 * Malformed inputs that should never be considered allowed. These are not
 * valid URLs at all (no `new URL()` parse) and exercise the "fall through
 * to false" branch of the helper.
 */
const malformedArb = fc.oneof(
  fc.constant(""),
  fc.constant("   "),
  fc.constant("not a url"),
  fc.constant("http//missing-colon.example.com"),
  fc.constant("://no-scheme.example.com"),
  fc.constant("http://[bad-ipv6"),
  fc.constant("ht!tp://bad.example.com"),
  // High-entropy junk — fast-check shrinks toward something readable.
  fc
    .string({ minLength: 0, maxLength: 64 })
    .filter((s) => {
      try {
        // Only keep strings that genuinely fail URL parsing.
        new URL(s);
        return false;
      } catch {
        return true;
      }
    }),
);

/** Mix of well-formed and malformed inputs in a single arbitrary. */
const urlArb = fc.oneof(buildUrlArb(), malformedArb);

/**
 * Reference oracle: the scheme allowlist is *exactly* "url parses AND
 * protocol is http: or https:". We re-derive it here using `new URL()`
 * directly so the property test is independent of the helper's internals.
 */
function expectedAllowed(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

describe("Property 5: Scheme allowlist", () => {
  it("isAllowedScheme(url) ⇔ url parses with http: or https: protocol", () => {
    fc.assert(
      fc.property(urlArb, (url) => {
        expect(isAllowedScheme(url)).toBe(expectedAllowed(url));
      }),
      { numRuns: 200 },
    );
  });

  it("rejects every non-http(s) scheme from the disallowed pool", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("ftp", "file", "data", "javascript", "gopher"),
        hostArb,
        (scheme, host) => {
          // Build a syntactically-plausible URL for the scheme.
          let url: string;
          if (scheme === "data") {
            url = "data:text/plain;base64,SGVsbG8=";
          } else if (scheme === "javascript") {
            url = "javascript:void(0)";
          } else if (scheme === "file") {
            url = "file:///etc/passwd";
          } else {
            url = `${scheme}://${host}/`;
          }
          expect(isAllowedScheme(url)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("accepts every http and https URL", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("http", "https"),
        hostArb,
        suffixArb,
        (scheme, host, suffix) => {
          const url = `${scheme}://${host}${suffix}`;
          expect(isAllowedScheme(url)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
