// Feature: web-search-and-fetch, Property 14: Audit log shape is correct and outcomes are exhaustively classified
//
// Validates: Requirements 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 1.9, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
//
// For arbitrary invocations of `webSearch` and `webFetch` (success and
// failure):
//
//   • The audit-log payload contains the structured fields required
//     by Requirement 5.5 (search) or Requirements 5.6–5.11 (fetch
//     with optional fields present iff the corresponding metadata
//     was produced).
//   • For any provider-side or transport-side failure, `error.kind`
//     is exactly one of the enumerated kinds and the human-readable
//     message names the active provider (search) or the matched
//     failure category (fetch).
//
// Both helpers route their payloads through `redact.stripForAudit` so
// sensitive header values and cookie values are stripped before the
// payload is built; the audit emission itself is verified by directly
// invoking the payload builders.

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  buildFetchAuditPayload,
  buildSearchAuditPayload,
} from "../../src/tools/web/audit.js";
import {
  METADATA_BUDGET_BYTES,
  type SearchProviderId,
  type WebFetchOutcome,
  type WebSearchErrorKind,
  type WebSearchOutcome,
} from "../../src/tools/web/types.js";

// Acceptable failure kinds per the design's error matrix.
const SEARCH_ERROR_KINDS: ReadonlyArray<WebSearchErrorKind> = [
  "auth",
  "rate-limit",
  "network",
  "parse",
  "server",
  "http",
  "timeout",
  "missing-key",
  "validation",
];

const FETCH_ERROR_KINDS = [
  "validation",
  "blocked-scheme",
  "blocked-address",
  "binary-content",
  "redirect-limit",
  "timeout",
  "http-error",
  "network",
  "decode",
] as const;

describe("Property 14: search audit-log shape and exhaustive error classification", () => {
  it("every payload contains exactly the required fields for the success/failure case", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<SearchProviderId>("brave", "tavily", "duckduckgo"),
        fc.boolean(),
        fc.integer({ min: 0, max: 4096 }),
        fc.array(
          fc.record({
            title: fc.string({ minLength: 1, maxLength: 50 }),
            url: fc.webUrl(),
            snippet: fc.string({ maxLength: 100 }),
          }),
          { maxLength: 5 },
        ),
        fc.constantFrom(...SEARCH_ERROR_KINDS),
        fc.option(fc.integer({ min: 100, max: 599 }), { nil: undefined }),
        (provider, ok, queryLength, results, kind, status) => {
          const outcome: WebSearchOutcome = ok
            ? { ok: true, provider, results }
            : {
                ok: false,
                provider,
                results: [],
                error: {
                  kind,
                  provider,
                  message: `${provider}: failed (${kind})`,
                  ...(status !== undefined ? { status } : {}),
                },
              };
          const payload = buildSearchAuditPayload(outcome, queryLength);

          // Required fields always present (Requirement 5.5).
          expect(payload.ok).toBe(ok);
          expect(payload.provider).toBe(provider);
          expect(Number.isInteger(payload.queryLength)).toBe(true);
          expect(payload.queryLength).toBe(queryLength);
          expect(Number.isInteger(payload.resultCount)).toBe(true);
          expect(payload.resultCount).toBe(ok ? results.length : 0);

          // Failure → categorical kind from the enum + provider name in message.
          if (!ok) {
            expect(SEARCH_ERROR_KINDS).toContain(payload.error?.kind);
            expect(payload.error?.message).toContain(provider);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 14: fetch audit-log shape and exhaustive error classification", () => {
  it("payload includes optional fields iff the corresponding metadata is present", () => {
    fc.assert(
      fc.property(
        fc.boolean(), // hasHeaders
        fc.boolean(), // hasTls
        fc.boolean(), // hasTiming
        fc.boolean(), // hasRedirect
        fc.boolean(), // hasCookies
        fc.boolean(), // ok
        fc.constantFrom(...FETCH_ERROR_KINDS),
        (
          hasHeaders,
          hasTls,
          hasTiming,
          hasRedirect,
          hasCookies,
          ok,
          errorKind,
        ) => {
          const outcome: WebFetchOutcome = {
            ok,
            metadata: {
              requestedUrl: "https://example.com/",
              finalUrl: "https://example.com/final",
              status: 200,
              resolvedIp: "93.184.216.34",
              finalHostname: "example.com",
              mode: "readable",
              bytesReceived: 100,
              truncated: false,
              budget: { metadataBytes: 0, cap: METADATA_BUDGET_BYTES },
              ...(hasHeaders ? { headers: { "content-type": "text/html" } } : {}),
              ...(hasTls
                ? {
                    tls: {
                      protocol: "TLSv1.3",
                      cipher: "TLS_AES_128_GCM_SHA256",
                      subjectCN: "example.com",
                      issuerCN: "Test CA",
                      subjectAltNames: [],
                      notBefore: "2024-01-01T00:00:00.000Z",
                      notAfter: "2030-01-01T00:00:00.000Z",
                      fingerprintSha256: "ab:cd:ef",
                    },
                  }
                : {}),
              ...(hasTiming
                ? {
                    timing: {
                      dnsMs: 1,
                      tcpMs: 2,
                      tlsMs: 3,
                      ttfbMs: 4,
                      totalMs: 10,
                    },
                  }
                : {}),
              ...(hasRedirect
                ? {
                    redirectChain: [
                      { url: "https://example.com/", status: 200 },
                    ],
                  }
                : {}),
              ...(hasCookies
                ? {
                    cookies: [
                      {
                        name: "sid",
                        value: "secret",
                        domain: "example.com",
                        path: "/",
                        httpOnly: true,
                        secure: true,
                        sameSite: "Lax",
                      },
                    ],
                  }
                : {}),
            },
            body: "ok",
            ...(ok
              ? {}
              : {
                  error: {
                    kind: errorKind,
                    message: `web.fetch: ${errorKind} failure`,
                    url: "https://example.com/",
                  },
                }),
          };

          const payload = buildFetchAuditPayload(outcome);

          // Always present (Requirements 5.6–5.7).
          expect(typeof payload.ok).toBe("boolean");
          expect(payload.requestedUrl).toBe("https://example.com/");
          expect(payload.finalUrl).toBe("https://example.com/final");
          expect(Number.isInteger(payload.bytesReceived)).toBe(true);
          expect(payload.resolvedIp).toBe("93.184.216.34");
          expect(payload.finalHostname).toBe("example.com");
          expect(payload.responseMode).toBe("readable");
          expect(Number.isInteger(payload.hopCount)).toBe(true);

          // Optional sub-objects iff their metadata produced one.
          expect(Object.prototype.hasOwnProperty.call(payload, "headers")).toBe(
            hasHeaders,
          );
          expect(Object.prototype.hasOwnProperty.call(payload, "tls")).toBe(
            hasTls,
          );
          expect(Object.prototype.hasOwnProperty.call(payload, "timing")).toBe(
            hasTiming,
          );
          expect(
            Object.prototype.hasOwnProperty.call(payload, "redirectChain"),
          ).toBe(hasRedirect);
          expect(Object.prototype.hasOwnProperty.call(payload, "cookies")).toBe(
            hasCookies,
          );

          // Failure → kind in the enum.
          if (!ok) {
            expect(FETCH_ERROR_KINDS as readonly string[]).toContain(
              payload.error?.kind,
            );
          }

          // Audit-log payload never carries cookie values, even when
          // cookies were captured.
          if (hasCookies && payload.cookies) {
            for (const c of payload.cookies) {
              expect(c).not.toHaveProperty("value");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
