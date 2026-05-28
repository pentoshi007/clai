// Feature: web-search-and-fetch, Property 12: Cookie capture cap
//
// Validates: Requirements 2.31
//
// For arbitrary redirect chains emitting 0..50 `Set-Cookie` headers
// distributed across all hops, the returned `cookies` array MUST contain
// exactly `min(observedSetCookies, 32)` entries with names and attributes
// preserved in the order observed; cookie values equal the literal
// `[REDACTED]` placeholder when `redactSensitive=true` and equal the
// source value when `redactSensitive=false`.
//
// The cap is enforced by `Capture.addSetCookieHeader` (silent drop after
// the {@link MAX_COOKIES_CAPTURED} threshold), is preserved across the
// `redact.applyToCookies` step, and survives the `budget.enforce` pass
// (the body+headers we send are tiny so the 64 KiB metadata budget never
// kicks in to drop cookies). We exercise the full `web.fetch` core
// pipeline through its injectable transport so the property captures
// the end-to-end behavior the agent observes via `metadata.cookies`.

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import fc from "fast-check";

import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import {
  MAX_COOKIES_CAPTURED,
  MAX_REDIRECT_HOPS,
  REDACTED_PLACEHOLDER,
  type CookieSameSite,
} from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// Cookie spec + Set-Cookie serializer
// ---------------------------------------------------------------------------

/**
 * The minimal shape we generate per cookie. Attributes are independently
 * sampled so the property exercises both sparse cookies (just name=value)
 * and richly-attributed ones.
 */
interface CookieSpec {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: CookieSameSite;
}

/**
 * Render a {@link CookieSpec} as a single `Set-Cookie` header value the
 * server would send on the wire. The serializer honours the same
 * subset of RFC 6265 attributes that `parseSetCookie` recognises in
 * `src/tools/web/readable.ts`, so the round-trip
 * spec → header → parsed CookieInfo is lossless for the fields the
 * pipeline surfaces.
 */
function buildSetCookieHeader(spec: CookieSpec): string {
  let out = `${spec.name}=${spec.value}`;
  if (spec.domain !== undefined) out += `; Domain=${spec.domain}`;
  if (spec.path !== undefined) out += `; Path=${spec.path}`;
  if (spec.httpOnly === true) out += `; HttpOnly`;
  if (spec.secure === true) out += `; Secure`;
  if (spec.sameSite !== undefined) out += `; SameSite=${spec.sameSite}`;
  return out;
}

// ---------------------------------------------------------------------------
// Multi-hop transport stub
// ---------------------------------------------------------------------------

/**
 * Description of a single hop the stub will emit. The terminal hop
 * (the last entry in the array fed to {@link makeMultiHopFetchStub})
 * returns a 200 response with a tiny text body; every earlier hop
 * returns a 302 redirect with a relative `Location` pointing at the
 * next hop's URL path.
 */
interface HopPlan {
  setCookies: string[];
}

/**
 * Build a deterministic in-process replacement for `https.request` that
 * drives `webFetchCore` through a chain of `hops.length` hops. Each
 * hop carries its own `Set-Cookie` header array; the body is a fixed
 * short string on the terminal hop so `metadata.bytesReceived` stays
 * well under any `maxBytes` and the 64 KiB metadata budget never kicks
 * in to drop cookies (which would otherwise interact with the property
 * under test). Hops up to {@link MAX_REDIRECT_HOPS}+1 are supported,
 * matching `fetch-core.ts`'s loop bound.
 */
function makeMultiHopFetchStub(hops: HopPlan[]): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
  dnsLookup: (
    host: string,
    o: unknown,
  ) => Promise<{ address: string; family: number }>;
} {
  let hopIndex = 0;

  const httpsRequest = (
    _url: string | URL,
    _options: unknown,
  ): ClientRequest => {
    const idx = hopIndex++;
    const plan = hops[idx];
    const isTerminal = idx === hops.length - 1;
    const setCookies = plan?.setCookies ?? [];

    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        // Fake TLS socket. `Capture.markTlsHandshaked` only reads these
        // accessors when the `secureConnect` event fires, so we provide
        // enough surface for it without fabricating real cert bytes.
        const socket = new EventEmitter() as unknown as {
          getProtocol: () => string;
          getCipher: () => { name: string };
          getPeerCertificate: (raw?: boolean) => Record<string, unknown>;
          emit: (...args: unknown[]) => void;
          once: (...args: unknown[]) => void;
        };
        socket.getProtocol = () => "TLSv1.3";
        socket.getCipher = () => ({ name: "TLS_AES_128_GCM_SHA256" });
        socket.getPeerCertificate = () => ({
          subject: { CN: "example.com" },
          issuer: { CN: "Test CA" },
          subjectaltname: "DNS:example.com",
          valid_from: "Jan  1 00:00:00 2024 GMT",
          valid_to: "Jan  1 00:00:00 2030 GMT",
          raw: Buffer.from([1, 2, 3]),
        });

        (req as unknown as { emit: (...a: unknown[]) => void }).emit(
          "socket",
          socket,
        );
        (socket as { emit: (...a: unknown[]) => void }).emit("connect");
        (socket as { emit: (...a: unknown[]) => void }).emit("secureConnect");

        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          headers: Record<string, string | string[]>;
          resume: () => void;
          destroy: () => void;
        };

        if (isTerminal) {
          res.statusCode = 200;
          res.headers = {
            "content-type": "text/plain; charset=utf-8",
            // Node's `http` module surfaces `set-cookie` as a `string[]`
            // when the header was sent multiple times — match that so
            // `collectSetCookieValues` sees the array path the
            // production code expects.
            "set-cookie": setCookies,
          };
        } else {
          res.statusCode = 302;
          // Each hop redirects to a new path on the same host; this
          // exercises `fetch-core.ts`'s relative-Location resolver.
          res.headers = {
            "content-type": "text/plain; charset=utf-8",
            location: `/hop/${idx + 1}`,
            "set-cookie": setCookies,
          };
        }
        res.resume = () => {};
        res.destroy = () => {};

        (req as unknown as { emit: (...a: unknown[]) => void }).emit(
          "response",
          res,
        );

        queueMicrotask(() => {
          if (isTerminal) {
            (res as { emit: (...a: unknown[]) => void }).emit(
              "data",
              Buffer.from("ok", "utf-8"),
            );
          }
          (res as { emit: (...a: unknown[]) => void }).emit("end");
        });
      });
    };
    return req;
  };

  const dnsLookup = async (
    _host: string,
    _o: unknown,
  ): Promise<{ address: string; family: number }> => ({
    address: "93.184.216.34",
    family: 4,
  });

  return { httpsRequest, dnsLookup };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Cookie name: ASCII letters/digits/underscore, 1..12 chars. Constrained
 * so the serializer never produces a header with `;`, `=`, or whitespace
 * inside the name, which would otherwise confuse `parseSetCookie`.
 */
const arbCookieName = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,11}$/);

/**
 * Cookie value: short ASCII alphanumeric. Excludes `;` (attribute
 * separator), `,` (audit-tagging-friendly), whitespace, and `=` so the
 * round-trip through `parseSetCookie` preserves the exact byte sequence.
 */
const arbCookieValue = fc.stringMatching(/^[A-Za-z0-9]{1,16}$/);

/** Optional Domain attribute drawn from a small set of valid hostnames. */
const arbCookieDomain = fc.option(
  fc.constantFrom("example.com", "sub.example.com", "test.local"),
  { nil: undefined },
);

/** Optional Path attribute drawn from a small set of valid paths. */
const arbCookiePath = fc.option(
  fc.constantFrom("/", "/api", "/api/v1", "/auth"),
  { nil: undefined },
);

/** Optional HttpOnly flag — present iff `true`. */
const arbHttpOnly = fc.option(fc.constant(true as const), { nil: undefined });

/** Optional Secure flag — present iff `true`. */
const arbSecure = fc.option(fc.constant(true as const), { nil: undefined });

/** Optional SameSite attribute. */
const arbSameSite = fc.option<CookieSameSite, undefined>(
  fc.constantFrom<CookieSameSite>("Strict", "Lax", "None"),
  { nil: undefined },
);

const arbCookieSpec: fc.Arbitrary<CookieSpec> = fc
  .record({
    name: arbCookieName,
    value: arbCookieValue,
    domain: arbCookieDomain,
    path: arbCookiePath,
    httpOnly: arbHttpOnly,
    secure: arbSecure,
    sameSite: arbSameSite,
  })
  .map((r) => {
    // Strip undefined keys so `expect(...).toEqual(...)` later does not
    // care about absent-vs-undefined distinctions.
    const out: CookieSpec = { name: r.name, value: r.value };
    if (r.domain !== undefined) out.domain = r.domain;
    if (r.path !== undefined) out.path = r.path;
    if (r.httpOnly !== undefined) out.httpOnly = r.httpOnly;
    if (r.secure !== undefined) out.secure = r.secure;
    if (r.sameSite !== undefined) out.sameSite = r.sameSite;
    return out;
  });

/** A list of 0..50 cookies covering both sides of the 32-entry cap. */
const arbCookieList = fc.array(arbCookieSpec, { minLength: 0, maxLength: 50 });

/**
 * Number of hops in the redirect chain. `1` means a single terminal
 * hop with no redirects; the upper bound `MAX_REDIRECT_HOPS + 1 = 6`
 * means five redirect hops followed by one terminal hop, the maximum
 * the fetch-core loop accepts before raising `redirect-limit`.
 */
const arbHopCount = fc.integer({ min: 1, max: MAX_REDIRECT_HOPS + 1 });

/**
 * Distribute the generated cookie list sequentially across `hopCount`
 * buckets. Each bucket is a contiguous slice of `specs`, so the order
 * the fetch core observes the cookies (hop 0 then hop 1 then ...)
 * exactly matches the order of `specs`. This is what lets the
 * assertion below check `cookies[i] === specs[i]` rather than
 * reconstructing a permutation.
 */
function distributeCookies(
  specs: readonly CookieSpec[],
  hopCount: number,
): CookieSpec[][] {
  const buckets: CookieSpec[][] = Array.from({ length: hopCount }, () => []);
  if (specs.length === 0) return buckets;
  const chunkSize = Math.ceil(specs.length / hopCount);
  for (let i = 0; i < hopCount; i++) {
    buckets[i] = specs.slice(i * chunkSize, (i + 1) * chunkSize);
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 12: Cookie capture cap", () => {
  it("metadata.cookies.length === min(observedSetCookies, 32) across redirect chains; names/attributes preserved; values redacted iff redactSensitive=true", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbCookieList,
        arbHopCount,
        fc.boolean(),
        async (specs, hopCount, redactSensitive) => {
          const buckets = distributeCookies(specs, hopCount);
          const hops: HopPlan[] = buckets.map((bucket) => ({
            setCookies: bucket.map(buildSetCookieHeader),
          }));
          const stub = makeMultiHopFetchStub(hops);

          const outcome = await webFetchCore(
            {
              url: "https://example.com/hop/0",
              redactSensitive,
            },
            stub,
          );

          expect(outcome.ok).toBe(true);

          const expectedCount = Math.min(specs.length, MAX_COOKIES_CAPTURED);
          const cookies = outcome.metadata.cookies ?? [];

          // 1. Length is exactly min(N, 32) regardless of how the
          //    cookies are spread across hops. Requirement 2.31.
          expect(cookies).toHaveLength(expectedCount);

          // 2. The first 32 (or fewer) entries — across all hops — are
          //    preserved in the order observed with names and
          //    structural attributes intact. Cookie values follow the
          //    redaction rule from Requirement 2.32.
          for (let i = 0; i < expectedCount; i++) {
            const expected = specs[i]!;
            const actual = cookies[i]!;

            // Name preserved.
            expect(actual.name).toBe(expected.name);

            // Value: redacted placeholder iff `redactSensitive=true`,
            // verbatim source value otherwise.
            if (redactSensitive) {
              expect(actual.value).toBe(REDACTED_PLACEHOLDER);
            } else {
              expect(actual.value).toBe(expected.value);
            }

            // Optional attributes preserved verbatim.
            expect(actual.domain).toBe(expected.domain);
            expect(actual.path).toBe(expected.path);
            expect(actual.httpOnly).toBe(expected.httpOnly);
            expect(actual.secure).toBe(expected.secure);
            expect(actual.sameSite).toBe(expected.sameSite);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
