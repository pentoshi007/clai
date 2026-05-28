// Feature: web-search-and-fetch, Property 11: Redaction is applied wherever required AND audit log never carries forbidden values
//
// Validates: Requirements 2.22, 2.32, 5.12, 5.13
//
// This property exercises the three exports of `src/tools/web/redact.ts`
// across arbitrary request/response shapes:
//
//   • applyToHeaders(redactSensitive=true): every Sensitive_Header
//     (case-insensitive: Cookie, Set-Cookie, Authorization,
//     Proxy-Authorization) in the returned HeaderMap has value
//     `[REDACTED]`; non-sensitive header values pass through under the
//     normal Header_Map rules (lower-cased keys, repeats joined with
//     `", "`). [Requirement 2.22]
//
//   • applyToCookies(redactSensitive=true): every cookie's `value`
//     equals `[REDACTED]`; all other attributes (name, domain, path,
//     expires, maxAge, httpOnly, secure, sameSite) are preserved
//     verbatim. [Requirement 2.32]
//
//   • stripForAudit (always, regardless of redactSensitive): the
//     returned AuditSafePayload contains no Sensitive_Header entry, no
//     cookie `value` field, and the original sensitive header values /
//     original cookie values do NOT appear anywhere in the
//     JSON-serialized payload. The payload is what `auditLog` would be
//     fed; no request body bytes are present because the API itself
//     does not accept a body argument. [Requirements 5.12, 5.13]
//
// The audit module integration (task 5.1) lands later; this property
// validates the redaction primitives the audit module composes on top
// of, which is sufficient for the contract under test.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyToCookies,
  applyToHeaders,
  SENSITIVE_HEADERS,
  stripForAudit,
  type HeaderEntries,
} from "../../src/tools/web/redact.js";
import {
  type CookieInfo,
  type CookieSameSite,
  REDACTED_PLACEHOLDER,
} from "../../src/tools/web/types.js";

/** Canonical Sensitive_Header names per Requirement 5.12. */
const SENSITIVE_NAMES = [
  "Cookie",
  "Set-Cookie",
  "Authorization",
  "Proxy-Authorization",
] as const;

/**
 * A header name generator that mixes sensitive names (in three casings
 * to exercise the case-insensitive matching) with arbitrary
 * non-sensitive names. Non-sensitive names are filtered to exclude the
 * sensitive set.
 */
const arbHeaderName = fc.oneof(
  fc.constantFrom(...SENSITIVE_NAMES),
  fc.constantFrom(...SENSITIVE_NAMES.map((s) => s.toLowerCase())),
  fc.constantFrom(...SENSITIVE_NAMES.map((s) => s.toUpperCase())),
  fc
    .stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,24}$/)
    .filter((s) => !SENSITIVE_HEADERS.has(s.toLowerCase())),
);

/**
 * Wraps an arbitrary value with a per-iteration nonce so the audit
 * payload check can assert the value never appears in the serialized
 * AuditSafePayload. The nonce is a randomly generated hex string fixed
 * for the iteration; all sensitive header values and cookie values are
 * prefixed with it. This avoids the false positives that would occur
 * if a non-sensitive header value happened to be a substring of a
 * sensitive one.
 */
const arbNonce = fc
  .uint8Array({ minLength: 8, maxLength: 8 })
  .map((bytes) =>
    "NONCE_" +
    Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join(""),
  );

/** Header value generator: short, non-empty, no control chars. */
const arbHeaderValue = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => !/[\r\n\0]/.test(s));

const arbSameSite = fc.option<CookieSameSite>(
  fc.constantFrom<CookieSameSite>("Strict", "Lax", "None"),
  { nil: undefined },
);

/**
 * Cookie generator: every field is independently arbitrary, with
 * optional fields drawn as `option(..., { nil: undefined })` so the
 * absence-vs-presence dimension is also covered. Names and values
 * exclude `;` to keep them syntactically valid cookies (the redact
 * module does not parse them, but it keeps the inputs realistic).
 */
const arbCookieRaw = fc.record({
  name: fc
    .string({ minLength: 1, maxLength: 24 })
    .filter((s) => !/[;=\s]/.test(s)),
  value: fc.string({ minLength: 0, maxLength: 32 }).filter((s) => !/[;]/.test(s)),
  domain: fc.option(fc.stringMatching(/^[a-z][a-z0-9.-]{0,24}$/), {
    nil: undefined,
  }),
  path: fc.option(fc.stringMatching(/^\/[A-Za-z0-9/_-]{0,24}$/), {
    nil: undefined,
  }),
  expires: fc.option(
    fc.constantFrom(
      "2024-01-01T00:00:00.000Z",
      "2030-12-31T23:59:59.000Z",
    ),
    { nil: undefined },
  ),
  maxAge: fc.option(fc.integer({ min: 0, max: 86_400 }), { nil: undefined }),
  httpOnly: fc.option(fc.boolean(), { nil: undefined }),
  secure: fc.option(fc.boolean(), { nil: undefined }),
  sameSite: arbSameSite,
});

/**
 * A bundled arbitrary that yields a single iteration's worth of state:
 * a header-entries list, a cookie list, a nonce, and a `redactSensitive`
 * flag. Sensitive header values and cookie values are deterministically
 * prefixed with the nonce so the audit-log "no forbidden value
 * appears" assertion can be checked by a substring scan.
 */
const arbScenario = fc
  .record({
    rawHeaders: fc.array(fc.tuple(arbHeaderName, arbHeaderValue), {
      minLength: 0,
      maxLength: 12,
    }),
    rawCookies: fc.array(arbCookieRaw, { minLength: 0, maxLength: 8 }),
    nonce: arbNonce,
    redactSensitive: fc.boolean(),
  })
  .map(({ rawHeaders, rawCookies, nonce, redactSensitive }) => {
    // Tag every sensitive header value with the nonce so we can later
    // assert the audit payload never carries it.
    const headers: HeaderEntries = rawHeaders.map(([name, value]) => {
      if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
        return [name, `${nonce}::${value}`] as const;
      }
      return [name, value] as const;
    });
    // Tag every cookie value with the nonce as well.
    const cookies: CookieInfo[] = rawCookies.map((c) => ({
      ...c,
      value: `${nonce}::${c.value}`,
    }));
    return { headers, cookies, nonce, redactSensitive };
  });

describe("Property 11: Redaction is applied wherever required AND audit log never carries forbidden values", () => {
  it("applies redaction in headers, cookies, and the audit-safe payload", () => {
    fc.assert(
      fc.property(arbScenario, ({ headers, cookies, nonce, redactSensitive }) => {
        // ---------------------------------------------------------------
        // Part A — applyToHeaders (Requirement 2.22)
        // ---------------------------------------------------------------
        const headerOut = applyToHeaders(headers, redactSensitive);

        // Group the input the same way the implementation does so we can
        // build an oracle for the expected joined value of each key.
        const grouped = new Map<string, string[]>();
        for (const [name, value] of headers) {
          const key = name.toLowerCase();
          const existing = grouped.get(key);
          if (existing) existing.push(value);
          else grouped.set(key, [value]);
        }

        // Every key in the output must come from the input and vice versa.
        expect(new Set(Object.keys(headerOut))).toEqual(new Set(grouped.keys()));

        for (const [key, values] of grouped) {
          if (redactSensitive && SENSITIVE_HEADERS.has(key)) {
            // Sensitive header values are replaced with the literal
            // [REDACTED] placeholder.
            expect(headerOut[key]).toBe(REDACTED_PLACEHOLDER);
          } else {
            // Non-sensitive (or non-redacted) headers must reflect the
            // RFC 7230 join of the original values. Generated values
            // are short enough that truncation never fires here.
            expect(headerOut[key]).toBe(values.join(", "));
          }
        }

        // ---------------------------------------------------------------
        // Part B — applyToCookies (Requirement 2.32)
        // ---------------------------------------------------------------
        const cookieOut = applyToCookies(cookies, redactSensitive);
        expect(cookieOut).toHaveLength(cookies.length);

        cookies.forEach((original, i) => {
          const result = cookieOut[i]!;
          if (redactSensitive) {
            // value is replaced with [REDACTED]; every other attribute
            // is preserved unchanged.
            expect(result).toEqual({ ...original, value: REDACTED_PLACEHOLDER });
          } else {
            // Verbatim shallow copy.
            expect(result).toEqual(original);
            // …but it must be a fresh object so callers can mutate it.
            expect(result).not.toBe(original);
          }
        });

        // ---------------------------------------------------------------
        // Part C — stripForAudit (Requirements 5.12, 5.13)
        //
        // This guarantee is independent of `redactSensitive`: the audit
        // log path strips sensitive headers and cookie values either
        // way. We feed it the **already-redacted** header map (so the
        // implementation's input shape matches the wire-up the audit
        // module will use) and the **original** cookies (so the
        // assertions catch the case where redaction is off but the
        // audit log must still drop the cookie value).
        // ---------------------------------------------------------------
        const auditPayload = stripForAudit(headerOut, cookies);

        // Sensitive headers are absent from the audit header map, by
        // both key and value.
        for (const key of Object.keys(auditPayload.headers)) {
          expect(SENSITIVE_HEADERS.has(key)).toBe(false);
        }

        // Cookies in the audit payload carry only the public attributes.
        // The `value` field must NOT be present at all.
        for (const c of auditPayload.cookies) {
          expect(Object.prototype.hasOwnProperty.call(c, "value")).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(c, "expires")).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(c, "maxAge")).toBe(false);
          // Allowed keys only.
          for (const key of Object.keys(c)) {
            expect([
              "name",
              "domain",
              "path",
              "httpOnly",
              "secure",
              "sameSite",
            ]).toContain(key);
          }
        }

        // The stronger guarantee: serialise the entire audit payload
        // (the bytes that an `auditLog` spy would observe) and assert
        // the per-iteration nonce never appears in it. Since every
        // sensitive header value and every cookie value was prefixed
        // with the nonce, finding it in the serialised output would
        // mean a forbidden value leaked through.
        const serialized = JSON.stringify(auditPayload);
        expect(serialized.includes(nonce)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});
