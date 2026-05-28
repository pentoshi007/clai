// Feature: web-search-and-fetch, Property 4: SSRF guard is consistent across the classifier and the fetch pipeline at every hop
//
// Validates: Requirements 2.8, 2.11, 5.3
//
// For arbitrary IP strings (IPv4 across the full byte range; IPv6 including
// `::1`, `fe80::*`, `fc00::/7`, `::ffff:127.0.0.1`, plus globally-routable
// addresses), assert `ssrf-guard.classify(ip)` returns a non-null class iff
// the IP belongs to loopback / RFC1918 / IPv4 link-local / IPv6 link-local /
// cloud-metadata (plus the CGNAT range that the implementation also covers
// per design 2.1), and that `classifyHost(literalIp)` agrees with
// `classify(ip)` so the safety classifier and the fetch pipeline never
// disagree about whether an address is blocked.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  classify,
  classifyHost,
  type AddressClass,
} from "../../src/tools/web/ssrf-guard.js";

/**
 * Independent reference predicate. Mirrors the address classes defined in
 * Requirements 2.8 and 5.3 (plus the CGNAT class added in design step 2.1)
 * using straightforward arithmetic so the property test does not duplicate
 * the implementation it validates beyond the bare predicate definition.
 *
 * Returns the most-specific expected class, or `null` for globally-routable
 * addresses that should not be blocked.
 */
function expectedClass(ip: string): AddressClass | null {
  // IPv4 dotted-quad
  const v4Parts = ip.split(".");
  if (v4Parts.length === 4 && v4Parts.every((p) => /^\d+$/.test(p))) {
    const nums = v4Parts.map((p) => Number(p));
    if (nums.every((n) => n >= 0 && n <= 255)) {
      const [a, b] = nums as [number, number, number, number];
      if (ip === "169.254.169.254") return "cloud-metadata";
      if (a === 127) return "loopback";
      if (a === 10) return "rfc1918";
      if (a === 172 && b >= 16 && b <= 31) return "rfc1918";
      if (a === 192 && b === 168) return "rfc1918";
      if (a === 169 && b === 254) return "ipv4-link-local";
      if (a === 100 && b >= 64 && b <= 127) return "cgnat";
      return null;
    }
  }
  // IPv6 — only classify the canonical/literal forms we generate below.
  // Lower-case for case-insensitive comparison.
  const lower = ip.toLowerCase();
  if (lower === "::1") return "loopback";
  if (lower === "::ffff:127.0.0.1") return "loopback";
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) {
    // fe80::/10 — top 10 bits == 1111 1110 10. Every fe80::/10 string we
    // generate falls into this range, so a literal startsWith on "fe80"
    // is sufficient for the inputs this test produces.
    return "ipv6-link-local";
  }
  if (lower === "fd00:ec2::254") return "cloud-metadata";
  if (
    lower.startsWith("fc") ||
    lower.startsWith("fd")
  ) {
    // fc00::/7 — top 7 bits == 1111 110.
    // First hextet is 0xfc** or 0xfd**, both in the ULA range.
    return "rfc1918";
  }
  return null;
}

/** Generator: arbitrary IPv4 across the full byte range (0..255 each octet). */
const arbitraryIpv4 = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map(([a, b, c, d]) => `${a}.${b}.${c}.${d}`);

/** Generator: representative IPv6 strings covering the property's enumerated cases. */
const arbitraryIpv6 = fc.oneof(
  fc.constant("::1"),
  fc.constant("::ffff:127.0.0.1"),
  fc.constant("fd00:ec2::254"),
  // fe80::/10 link-local with arbitrary trailing hextet.
  fc
    .integer({ min: 0, max: 0xffff })
    .map((n) => `fe80::${n.toString(16)}`),
  // fc00::/7 ULA range. First hextet is 0xfc00..0xfdff.
  fc
    .tuple(
      fc.integer({ min: 0xfc00, max: 0xfdff }),
      fc.integer({ min: 0, max: 0xffff }),
    )
    .map(([h0, tail]) => `${h0.toString(16)}::${tail.toString(16)}`),
  // Globally-routable IPv6 addresses (must classify as null).
  fc.constant("2001:4860:4860::8888"),
  fc.constant("2606:4700:4700::1111"),
  fc.constant("2a00:1450:4001:81b::200e"),
);

const arbitraryIp = fc.oneof(arbitraryIpv4, arbitraryIpv6);

describe("Property 4: SSRF guard is consistent across the classifier and the fetch pipeline", () => {
  it("classify(ip) is non-null iff the IP belongs to a blocked class, and classifyHost agrees", () => {
    fc.assert(
      fc.property(arbitraryIp, (ip) => {
        const expected = expectedClass(ip);
        const actual = classify(ip);

        // 1. classify returns non-null iff the IP belongs to a blocked class.
        if (expected === null) {
          expect(actual).toBeNull();
        } else {
          expect(actual).not.toBeNull();
          expect(actual?.class).toBe(expected);
        }

        // 2. classifyHost(literalIp) agrees with classify(ip) for literal
        // IPs — the pipeline (which calls classify on the resolved IP) and
        // the safety classifier (which calls classifyHost on the URL host
        // literal) must never disagree about whether an address is blocked.
        const viaHost = classifyHost(ip);
        if (actual === null) {
          expect(viaHost).toBeNull();
        } else {
          expect(viaHost).not.toBeNull();
          expect(viaHost?.class).toBe(actual.class);
        }
      }),
      { numRuns: 200 },
    );
  });
});
