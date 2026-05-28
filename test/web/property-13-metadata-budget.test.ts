// Feature: web-search-and-fetch, Property 13: 64 KiB metadata budget with deterministic truncation order
//
// Validates: Requirements 2.35
//
// For arbitrary metadata payloads (combinations of header counts/sizes,
// cookie counts, redirect-chain length), `enforce` from
// `src/tools/web/budget.ts` must:
//
//   • Return `metadataBytes ≤ 65 536` for the JSON-serialized
//     `{headers, tls, timing, redirectChain, cookies}`. The only
//     exception is the documented edge case where every reduction
//     step is exhausted — `cookies` is empty, no header value's
//     content portion exceeds 1024 chars, and `redirectChain` is
//     empty — yet the total still exceeds the cap. In that case the
//     loop is provably stuck and the overflow is surfaced verbatim.
//
//   • Apply the truncation order from
//     `.kiro/specs/web-search-and-fetch/design.md`,
//     "Truncation order at the 64 KiB cap":
//
//       1. Drop trailing cookies (last entry first).
//       2. Halve the longest header value (with `[...truncated]`)
//          until every header value's content portion is ≤ 1024.
//       3. Drop trailing redirect hops one at a time.
//
//     We verify the order by tracking which fields shrank: if any
//     header was halved, all cookies must have been drained first;
//     if any redirect hop was dropped, every header value must
//     already be at the 1024-char floor and cookies must be empty.
//
//   • Leave `tls` and `timing` referentially equal to the inputs
//     (the loop never touches them) and copy `cookies` /
//     `redirectChain` so the original arrays are untouched.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { enforce } from "../../src/tools/web/budget.js";
import {
  type CookieInfo,
  type HeaderMap,
  type RedirectChain,
  type RedirectHop,
  type TimingInfo,
  type TlsInfo,
  METADATA_BUDGET_BYTES,
  TRUNCATION_MARKER,
} from "../../src/tools/web/types.js";

/**
 * Per-header-value floor mirrored from `budget.ts`. The implementation
 * stops halving a header value once its content portion (length minus
 * the {@link TRUNCATION_MARKER} suffix) is ≤ this many characters.
 */
const HEADER_VALUE_FLOOR = 1024;

/**
 * Length of the "content" portion of a header value — the full string
 * minus a trailing {@link TRUNCATION_MARKER}, when present. Mirrors
 * the helper of the same purpose in `budget.ts` so the test does not
 * depend on the implementation's internal helpers.
 */
const contentLength = (v: string): number =>
  v.endsWith(TRUNCATION_MARKER)
    ? v.length - TRUNCATION_MARKER.length
    : v.length;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A fixed `TlsInfo`. The cap loop never inspects or modifies `tls`, so
 * a single canned record is sufficient; the property under test only
 * needs `tls` to be referentially preserved across the call.
 */
const arbTls: fc.Arbitrary<TlsInfo> = fc.constant<TlsInfo>({
  protocol: "TLSv1.3",
  cipher: "TLS_AES_128_GCM_SHA256",
  subjectCN: "example.com",
  issuerCN: "Example CA",
  subjectAltNames: ["example.com", "www.example.com"],
  notBefore: "2024-01-01T00:00:00.000Z",
  notAfter: "2030-12-31T23:59:59.000Z",
  fingerprintSha256:
    "ab:cd:ef:01:02:03:04:05:06:07:08:09:0a:0b:0c:0d:" +
    "0e:0f:10:11:12:13:14:15:16:17:18:19:1a:1b:1c:1d",
});

/** A fixed `TimingInfo`. Same rationale as `arbTls`. */
const arbTiming: fc.Arbitrary<TimingInfo> = fc.constant<TimingInfo>({
  dnsMs: 12,
  tcpMs: 34,
  tlsMs: 56,
  ttfbMs: 78,
  totalMs: 200,
});

/**
 * Header key generator. Lower-cased alpha-num + dash matches the
 * canonical {@link HeaderMap} shape, and the length cap keeps
 * generated payloads from drowning the test in noise.
 */
const arbHeaderKey: fc.Arbitrary<string> = fc.stringMatching(
  /^[a-z][a-z0-9-]{1,32}$/,
);

/**
 * Header value generator. We use repeated `'v'` characters of
 * arbitrary length so:
 *   • The serialized header has predictable size.
 *   • Halving never accidentally produces a string ending in
 *     {@link TRUNCATION_MARKER}, which would confuse the
 *     "was-halved" detector below.
 *   • The min length of 1 keeps every value non-empty so the map
 *     entry is preserved in JSON.
 *
 * The max of 4 KiB ensures plenty of values exceed the 1024-char
 * floor and therefore exercise the halving loop multiple times.
 */
const arbHeaderValue: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: 4096 })
  .map((n) => "v".repeat(n));

/**
 * Header map generator. Up to 60 entries lets some inputs exceed
 * 64 KiB even after every header is halved to 1024 chars, which is
 * what forces the redirect-drop step. Duplicates after dedup are
 * fine — we just want a `HeaderMap` with arbitrary key/value sizes.
 */
const arbHeaders: fc.Arbitrary<HeaderMap> = fc
  .array(fc.tuple(arbHeaderKey, arbHeaderValue), {
    minLength: 0,
    maxLength: 60,
  })
  .map((entries) => {
    const out: HeaderMap = {};
    for (const [k, v] of entries) out[k] = v;
    return out;
  });

/**
 * Cookie generator. Each cookie's `name` carries the per-iteration
 * sequence id so the prefix-equality check below is unambiguous even
 * if `fc` happens to produce two cookies with otherwise identical
 * fields. Values are a fixed-width filler so cookie size scales
 * linearly with the array length and the property reliably triggers
 * the cookie-drop step at higher counts.
 */
const arbCookie = (id: number): fc.Arbitrary<CookieInfo> =>
  fc.constant<CookieInfo>({
    name: `cookie_${id}`,
    value: "x".repeat(50),
    domain: "example.com",
    path: "/",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  });

const arbCookies: fc.Arbitrary<CookieInfo[]> = fc
  .integer({ min: 0, max: 32 })
  .chain((n) =>
    fc.tuple(...Array.from({ length: n }, (_, i) => arbCookie(i))),
  )
  .map((arr) => [...arr]);

/** Redirect-hop generator with a position-tagged URL for prefix checks. */
const arbHop = (id: number): fc.Arbitrary<RedirectHop> =>
  fc.constant<RedirectHop>({
    url: `https://example.com/path/${id}`,
    status: 301,
  });

const arbRedirectChain: fc.Arbitrary<RedirectChain> = fc
  .integer({ min: 0, max: 5 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbHop(i))))
  .map((arr) => [...arr]);

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 13: 64 KiB metadata budget with deterministic truncation order", () => {
  it("enforces the cap and the cookies → headers → redirects order", () => {
    fc.assert(
      fc.property(
        fc.record({
          headers: arbHeaders,
          tls: arbTls,
          timing: arbTiming,
          redirectChain: arbRedirectChain,
          cookies: arbCookies,
        }),
        (input) => {
          const result = enforce(input);

          // -----------------------------------------------------------
          // tls / timing are passed through by reference. The budget
          // loop never inspects either field, so the caller's exact
          // object should appear on the result.
          // -----------------------------------------------------------
          expect(result.tls).toBe(input.tls);
          expect(result.timing).toBe(input.timing);

          // -----------------------------------------------------------
          // cookies are popped from the END (last entry first), so the
          // output must be a strict prefix of the input array.
          // -----------------------------------------------------------
          const resultCookies: CookieInfo[] = result.cookies ?? [];
          expect(resultCookies.length).toBeLessThanOrEqual(
            input.cookies.length,
          );
          for (let i = 0; i < resultCookies.length; i++) {
            expect(resultCookies[i]).toEqual(input.cookies[i]);
          }

          // -----------------------------------------------------------
          // redirect hops are also dropped from the END.
          // -----------------------------------------------------------
          const resultRedirects: RedirectChain = result.redirectChain ?? [];
          expect(resultRedirects.length).toBeLessThanOrEqual(
            input.redirectChain.length,
          );
          for (let i = 0; i < resultRedirects.length; i++) {
            expect(resultRedirects[i]).toEqual(input.redirectChain[i]);
          }

          // -----------------------------------------------------------
          // headers: every input key is preserved on the output (the
          // loop value-truncates rather than removing keys). Each
          // value is either unchanged or shorter and ending in the
          // truncation marker.
          // -----------------------------------------------------------
          const resultHeaders: HeaderMap = result.headers ?? {};
          expect(new Set(Object.keys(resultHeaders))).toEqual(
            new Set(Object.keys(input.headers)),
          );

          let anyHeaderHalved = false;
          for (const [key, original] of Object.entries(input.headers)) {
            const v = resultHeaders[key];
            expect(v).toBeDefined();
            if (v === original) {
              // unchanged — fine.
            } else if (v !== undefined && v.length < original.length) {
              expect(v.endsWith(TRUNCATION_MARKER)).toBe(true);
              anyHeaderHalved = true;
            } else {
              throw new Error(
                `header ${key} was modified but not shortened: ` +
                  `original=${original.length} chars, result=${v?.length} chars`,
              );
            }
          }

          // -----------------------------------------------------------
          // Order invariant 1: cookies drained before any header is
          // halved. If even one header was halved, the cookie array
          // must have reached length 0 first.
          // -----------------------------------------------------------
          if (anyHeaderHalved) {
            expect(resultCookies.length).toBe(0);
          }

          // -----------------------------------------------------------
          // Order invariant 2: every halve-able header reaches the
          // 1024-char floor before any redirect hop is dropped, AND
          // cookies are already empty by then.
          // -----------------------------------------------------------
          const hopsDropped =
            input.redirectChain.length - resultRedirects.length;
          if (hopsDropped > 0) {
            expect(resultCookies.length).toBe(0);
            for (const v of Object.values(resultHeaders)) {
              expect(contentLength(v)).toBeLessThanOrEqual(HEADER_VALUE_FLOOR);
            }
          }

          // -----------------------------------------------------------
          // Size: the result must be at or under the 64 KiB cap. The
          // documented edge case is that the loop ran out of moves
          // (no cookies, no halve-able header, no redirect hops) yet
          // the total still exceeds the cap; in that case overflow is
          // surfaced verbatim and we accept it iff every reduction
          // step is exhausted.
          // -----------------------------------------------------------
          expect(result.cap).toBe(METADATA_BUDGET_BYTES);
          if (result.metadataBytes > METADATA_BUDGET_BYTES) {
            const noCookies = resultCookies.length === 0;
            const noHalveable = Object.values(resultHeaders).every(
              (v) => contentLength(v) <= HEADER_VALUE_FLOOR,
            );
            const noHops = resultRedirects.length === 0;
            expect(noCookies && noHalveable && noHops).toBe(true);
          }

          // -----------------------------------------------------------
          // The reported byte count must match the actual UTF-8 byte
          // length of the JSON serialization of the (possibly
          // shortened) metadata fields.
          // -----------------------------------------------------------
          const measured = Buffer.byteLength(
            JSON.stringify({
              headers: result.headers,
              tls: result.tls,
              timing: result.timing,
              redirectChain: result.redirectChain,
              cookies: result.cookies,
            }),
            "utf8",
          );
          expect(result.metadataBytes).toBe(measured);
        },
      ),
      { numRuns: 100 },
    );
  });
});
