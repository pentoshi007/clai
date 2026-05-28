// Feature: web-search-and-fetch, Property 10: Header-value truncation
//
// Validates: Requirements 2.21
//
// For arbitrary HTTP header values (any UTF-8 string), the returned
// `HeaderMap` value MUST satisfy:
//
//   1. `value.length <= MAX_HEADER_VALUE_LENGTH + TRUNCATION_MARKER.length`
//      (the truncated form fits inside the documented cap), and
//   2. `value.endsWith(TRUNCATION_MARKER)` iff the original (joined-after-
//      RFC-7230-merge) value's character length exceeded
//      `MAX_HEADER_VALUE_LENGTH`, and
//   3. when no truncation occurs, the returned value equals the joined
//      source verbatim.
//
// Setup notes
// -----------
// • `redactSensitive=false` so the truncation path is exercised on every
//   header (including ones that would otherwise short-circuit through the
//   redaction branch). Property 11 covers redaction; this test isolates
//   the truncation rule from Requirement 2.21.
// • Both `HeaderMap` (flat record) and `HeaderEntries` (ordered
//   `[name, value]` pairs with possible repeats) input shapes are
//   exercised. The pair shape is the only way to drive the RFC-7230 join
//   that produces a single string the cap is measured against.
// • The header-name generator is restricted to lower-case ASCII so that
//   the input map's key set already matches the canonical lower-cased
//   output; this lets the test correlate input keys with output keys
//   without re-implementing the lower-casing rule.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyToHeaders,
  type HeaderEntries,
} from "../../src/tools/web/redact.js";
import {
  MAX_HEADER_VALUE_LENGTH,
  TRUNCATION_MARKER,
  type HeaderMap,
} from "../../src/tools/web/types.js";

/**
 * Header-name generator. Lower-case ASCII tokens of length 1..16 chosen so
 * that the input record's keys already match the canonical lower-cased
 * output (the implementation always lower-cases). A small pool of names
 * makes repeated-name collisions likely, which exercises the RFC-7230
 * join path that the truncation cap is measured against.
 */
const headerNameArb = fc.constantFrom(
  "x-test",
  "x-foo",
  "x-bar",
  "x-baz",
  "etag",
  "server",
  "vary",
  "content-type",
);

/**
 * Header-value generator. A weighted mix of length regions so each run
 * exercises:
 *
 *   • short values (well under the 4096-char cap),
 *   • values straddling the cap (a few characters either side, where
 *     off-by-one errors live),
 *   • values clearly over the cap (so the truncation branch fires after
 *     the join, not just on a single oversize entry), and
 *   • a wide-range tail so fast-check can still find unusual inputs.
 *
 * `fc.string()` produces arbitrary 16-bit code-unit strings; the
 * implementation measures with JS `.length` (UTF-16 code units), which is
 * how the requirement's "characters" are counted, so the property is
 * stated in those same units.
 */
const headerValueArb = fc.oneof(
  { weight: 3, arbitrary: fc.string({ minLength: 0, maxLength: 100 }) },
  {
    weight: 2,
    arbitrary: fc.string({ minLength: 4080, maxLength: 4110 }),
  },
  {
    weight: 2,
    arbitrary: fc.string({ minLength: 4097, maxLength: 6000 }),
  },
  { weight: 1, arbitrary: fc.string({ minLength: 0, maxLength: 8200 }) },
);

/** Ordered list of `[name, value]` pairs, possibly repeating names. */
const headerEntriesArb: fc.Arbitrary<HeaderEntries> = fc.array(
  fc.tuple(headerNameArb, headerValueArb),
  { minLength: 1, maxLength: 6 },
);

/**
 * Reference: how repeated header names are joined per RFC 7230. Mirrors
 * the implementation's `values.join(", ")` step but is stated
 * independently here so the property does not just re-execute the
 * implementation it validates.
 */
function joinByName(entries: HeaderEntries): Map<string, string> {
  const grouped = new Map<string, string[]>();
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    const existing = grouped.get(key);
    if (existing) existing.push(value);
    else grouped.set(key, [value]);
  }
  const out = new Map<string, string>();
  for (const [k, vs] of grouped) out.set(k, vs.join(", "));
  return out;
}

/** The hard ceiling on any output value's character length per Property 10. */
const MAX_OUTPUT_LENGTH =
  MAX_HEADER_VALUE_LENGTH + TRUNCATION_MARKER.length;

describe("Property 10: Header-value truncation (Requirement 2.21)", () => {
  it("HeaderEntries form: joined value is capped, marker iff joined.length > 4096", () => {
    fc.assert(
      fc.property(headerEntriesArb, (entries) => {
        const result: HeaderMap = applyToHeaders(entries, false);
        const joinedByName = joinByName(entries);

        // Output keys must match the joined input's key set (lower-cased).
        expect(new Set(Object.keys(result))).toEqual(
          new Set(joinedByName.keys()),
        );

        for (const [name, joined] of joinedByName) {
          const value = result[name]!;

          // 1. Length cap holds for every output value.
          expect(value.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);

          if (joined.length > MAX_HEADER_VALUE_LENGTH) {
            // 2a. Over-cap inputs are truncated to exactly the cap and
            //     end with the literal marker.
            expect(value.endsWith(TRUNCATION_MARKER)).toBe(true);
            expect(value.length).toBe(MAX_OUTPUT_LENGTH);
            expect(value.slice(0, MAX_HEADER_VALUE_LENGTH)).toBe(
              joined.slice(0, MAX_HEADER_VALUE_LENGTH),
            );
          } else {
            // 2b. Under-cap (and exactly-at-cap) inputs round-trip
            //     verbatim with no marker appended.
            expect(value).toBe(joined);
            expect(value.endsWith(TRUNCATION_MARKER)).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("HeaderMap form: single-value inputs are capped, marker iff value.length > 4096", () => {
    // Flat HeaderMap inputs cannot encode repeats by construction, so this
    // case isolates the truncation rule from the join step. Both shapes
    // must satisfy Property 10 — the `applyToHeaders` contract is shape-
    // agnostic.
    const flatMapArb = fc
      .array(fc.tuple(headerNameArb, headerValueArb), {
        minLength: 1,
        maxLength: 6,
      })
      .map((pairs): HeaderMap => {
        const m: HeaderMap = {};
        for (const [n, v] of pairs) m[n.toLowerCase()] = v; // de-dup keeps last
        return m;
      });

    fc.assert(
      fc.property(flatMapArb, (input) => {
        const result = applyToHeaders(input, false);

        expect(new Set(Object.keys(result))).toEqual(
          new Set(Object.keys(input)),
        );

        for (const [name, source] of Object.entries(input)) {
          const value = result[name]!;
          expect(value.length).toBeLessThanOrEqual(MAX_OUTPUT_LENGTH);

          if (source.length > MAX_HEADER_VALUE_LENGTH) {
            expect(value.endsWith(TRUNCATION_MARKER)).toBe(true);
            expect(value.length).toBe(MAX_OUTPUT_LENGTH);
            expect(value.slice(0, MAX_HEADER_VALUE_LENGTH)).toBe(
              source.slice(0, MAX_HEADER_VALUE_LENGTH),
            );
          } else {
            expect(value).toBe(source);
            expect(value.endsWith(TRUNCATION_MARKER)).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
