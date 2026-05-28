// Feature: web-search-and-fetch, Property 3: web.fetch input validation
//
// Validates: Requirements 2.1, 2.2, 2.12, 2.13, 2.33, 2.34
//
// For arbitrary `(url, maxBytes, includeHeaders, includeTls, includeTiming,
// includeRedirectChain, responseMode, redactSensitive)` tuples, `web.fetch`
// returns `ok=true` exactly when every argument satisfies its declared
// type/range; otherwise `ok=false` with an error message that names the
// offending argument and the rule that was violated.
//
// Validation lives in `fetch-core.ts::validateArgs` (per the design's
// "Pipeline steps in detail" §1) and runs synchronously before any I/O. The
// `webFetchCore` orchestrator is invoked here through its injectable
// transport so no real network calls are made — the stubbed
// `httpsRequest`/`httpRequest`/`dnsLookup` only fire on the *valid* branch
// (so we can confirm `ok=true` is reachable); the invalid branch never
// reaches the network because validation short-circuits.

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import fc from "fast-check";

import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import {
  MAX_MAX_BYTES,
  MIN_MAX_BYTES,
} from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

/**
 * Build an in-process replacement for `http(s).request` that drives the
 * {@link webFetchCore} pipeline through one terminal `200 OK` hop. Used by
 * the *valid* branch of the property to confirm a syntactically-correct
 * argument tuple actually reaches `ok=true`.
 *
 * The stub is intentionally minimal: a 25-byte ASCII body with
 * `text/plain; charset=utf-8` so neither response-mode branch in
 * `classifyAndDecodeBody` does any HTML conversion. The companion
 * `dnsLookup` returns the canonical example.com IPv4 (93.184.216.34) which
 * does not fall in any SSRF address class.
 */
function makeFetchStub(): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
  httpRequest: (url: string | URL, options: unknown) => ClientRequest;
  dnsLookup: (
    host: string,
    o: unknown,
  ) => Promise<{ address: string; family: number }>;
} {
  const body = Buffer.from("hello from web.fetch property test", "utf-8");

  const buildRequest = (isHttps: boolean) =>
    function request(_url: string | URL, _options: unknown): ClientRequest {
      const req = new EventEmitter() as unknown as ClientRequest;
      // `end` is the only `ClientRequest` method `webFetchCore` calls.
      // Schedule the synthetic socket/response flow on the next microtask
      // so the orchestrator has time to attach its listeners first.
      (req as unknown as { end: () => void }).end = (): void => {
        queueMicrotask(() => {
          // Fake socket. For https we expose the TLS capture surface that
          // `Capture.markTlsHandshaked` consults; for http only `connect`
          // is observed.
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
          if (isHttps) {
            (socket as { emit: (...a: unknown[]) => void }).emit(
              "secureConnect",
            );
          }

          const res = new EventEmitter() as unknown as IncomingMessage & {
            statusCode: number;
            headers: Record<string, string>;
            resume: () => void;
            destroy: () => void;
          };
          res.statusCode = 200;
          res.headers = { "content-type": "text/plain; charset=utf-8" };
          res.resume = () => {};
          res.destroy = () => {};

          (req as unknown as { emit: (...a: unknown[]) => void }).emit(
            "response",
            res,
          );

          queueMicrotask(() => {
            (res as { emit: (...a: unknown[]) => void }).emit("data", body);
            (res as { emit: (...a: unknown[]) => void }).emit("end");
          });
        });
      };
      return req;
    };

  return {
    httpsRequest: buildRequest(true),
    httpRequest: buildRequest(false),
    dnsLookup: async (
      _host: string,
      _o: unknown,
    ): Promise<{ address: string; family: number }> => ({
      address: "93.184.216.34",
      family: 4,
    }),
  };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Hostnames that are guaranteed not to classify as a blocked SSRF address
 * class. We restrict the host pool to public-looking names so the property
 * isolates *argument* validation from the SSRF guard's address checks.
 */
const safeHostArb = fc.constantFrom(
  "example.com",
  "www.example.org",
  "search.example.net",
  "docs.example.io",
);

/** Path/query suffix kept simple so the URL stays parseable. */
const safeSuffixArb = fc.oneof(
  fc.constant(""),
  fc.constant("/"),
  fc.constant("/path"),
  fc.constant("/a/b?c=1"),
  fc.constant("/x#frag"),
);

/** A valid URL in the http(s) scheme allowlist with a public-looking host. */
const validUrlArb = fc
  .tuple(fc.constantFrom("https", "http"), safeHostArb, safeSuffixArb)
  .map(([scheme, host, suffix]) => `${scheme}://${host}${suffix}`);

/**
 * URL strings that the validator must reject. Each element exercises a
 * different rule from `validateArgs`:
 *
 *   - `""`                                        → required/non-empty
 *   - whitespace inside the URL                   → Requirement 7.3
 *   - ASCII control character inside the URL      → Requirement 7.3
 *   - non-http(s) scheme                          → Requirement 2.1 / 5.4
 *   - unparseable garbage                         → URL parse failure
 */
const invalidUrlArb = fc.oneof(
  fc.constant(""),
  fc.constant("https://exa mple.com/"),
  fc.constant("http://example.com/with space"),
  fc.constant("https://example.com/\u0000"),
  fc.constant("https://example.com/\u0007"),
  fc.constant("ftp://example.com/"),
  fc.constant("file:///etc/passwd"),
  fc.constant("javascript:alert(1)"),
  fc.constant("gopher://example.com/"),
  fc.constant("data:text/plain,hello"),
  fc.constant("not a url"),
  fc.constant("://no-scheme.example.com/"),
);

/** A valid `maxBytes`: either omitted or an integer in the documented range. */
const validMaxBytesArb = fc.oneof(
  fc.constant(undefined as number | undefined),
  fc.integer({ min: MIN_MAX_BYTES, max: MAX_MAX_BYTES }),
);

/**
 * An invalid `maxBytes`. We mix three families:
 *   - integer below the minimum
 *   - integer above the maximum
 *   - non-integer numeric (float)
 *
 * Non-numeric types are covered by the union typing below.
 */
const invalidMaxBytesArb = fc.oneof(
  fc.integer({ min: -1_000_000, max: MIN_MAX_BYTES - 1 }),
  fc.integer({ min: MAX_MAX_BYTES + 1, max: MAX_MAX_BYTES + 1_000_000 }),
  // Floats that are definitely not integers (forced fractional component).
  fc
    .double({ min: MIN_MAX_BYTES, max: MAX_MAX_BYTES, noNaN: true })
    .filter((n) => !Number.isInteger(n)),
);

/** A valid optional boolean: undefined, true, or false. */
const validBoolArb = fc.oneof(
  fc.constant(undefined as boolean | undefined),
  fc.boolean(),
);

/** A non-boolean value that the validator must reject. */
const invalidBoolArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 8 }),
  fc.integer({ min: -100, max: 100 }),
  fc.constant(0),
  fc.constant(1),
  fc.constant(null),
);

/** A valid `responseMode`: undefined, `"readable"`, or `"raw"`. */
const validResponseModeArb = fc.oneof(
  fc.constant(undefined as string | undefined),
  fc.constantFrom("readable", "raw"),
);

/** A `responseMode` value the validator must reject. */
const invalidResponseModeArb = fc.oneof(
  fc.constant("RAW"),
  fc.constant("Readable"),
  fc.constant("html"),
  fc.constant("text"),
  fc.constant(""),
  fc
    .string({ minLength: 1, maxLength: 12 })
    .filter((s) => s !== "readable" && s !== "raw"),
  fc.integer(),
  fc.boolean(),
);

/**
 * The full argument tuple. Every field independently picks between its
 * "valid" and "invalid" arbitrary so every combination of (some valid,
 * some invalid) shows up in the 100+ runs.
 *
 * Valid is weighted slightly heavier than invalid for each individual
 * field so the tuple has a meaningful chance of being entirely valid
 * (which exercises the `ok=true` branch); the invalid weight is high
 * enough that single-field violations dominate the distribution.
 */
type ArbValue<T> = T;

interface RawArgs {
  url: ArbValue<unknown>;
  maxBytes: ArbValue<unknown>;
  includeHeaders: ArbValue<unknown>;
  includeTls: ArbValue<unknown>;
  includeTiming: ArbValue<unknown>;
  includeRedirectChain: ArbValue<unknown>;
  responseMode: ArbValue<unknown>;
  redactSensitive: ArbValue<unknown>;
}

const argsArb: fc.Arbitrary<RawArgs> = fc.record({
  url: fc.oneof(
    { weight: 3, arbitrary: validUrlArb },
    { weight: 2, arbitrary: invalidUrlArb },
  ),
  maxBytes: fc.oneof(
    { weight: 3, arbitrary: validMaxBytesArb },
    { weight: 1, arbitrary: invalidMaxBytesArb },
  ),
  includeHeaders: fc.oneof(
    { weight: 3, arbitrary: validBoolArb },
    { weight: 1, arbitrary: invalidBoolArb },
  ),
  includeTls: fc.oneof(
    { weight: 3, arbitrary: validBoolArb },
    { weight: 1, arbitrary: invalidBoolArb },
  ),
  includeTiming: fc.oneof(
    { weight: 3, arbitrary: validBoolArb },
    { weight: 1, arbitrary: invalidBoolArb },
  ),
  includeRedirectChain: fc.oneof(
    { weight: 3, arbitrary: validBoolArb },
    { weight: 1, arbitrary: invalidBoolArb },
  ),
  responseMode: fc.oneof(
    { weight: 3, arbitrary: validResponseModeArb },
    { weight: 1, arbitrary: invalidResponseModeArb },
  ),
  redactSensitive: fc.oneof(
    { weight: 3, arbitrary: validBoolArb },
    { weight: 1, arbitrary: invalidBoolArb },
  ),
});

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

/**
 * Argument names checked by `validateArgs`, in the *exact* order the
 * validator checks them. The "first" violation reported by `webFetchCore`
 * is the first failure in this order — the oracle replicates that order so
 * the property can identify which argument the error message must name.
 */
type OffendingArg =
  | "url"
  | "maxBytes"
  | "includeHeaders"
  | "includeTls"
  | "includeTiming"
  | "includeRedirectChain"
  | "responseMode"
  | "redactSensitive";

/**
 * Reference oracle. Returns `null` when every argument is valid; otherwise
 * the name of the first offending argument in the validator's check order.
 *
 * This re-derives the rules from the requirements (2.1, 2.2, 2.12, 2.13,
 * 2.33, 2.34) so the property is independent of `validateArgs`'s internal
 * implementation — it only depends on the documented contract.
 */
function offendingArgument(args: RawArgs): OffendingArg | null {
  // url: required, non-empty string, no whitespace, no control chars,
  // parses as absolute URL with scheme http: or https: (Requirements 2.1,
  // 2.12, 7.1, 7.3).
  if (typeof args.url !== "string" || args.url.length === 0) return "url";
  if (/\s/.test(args.url)) return "url";
  if (/[\u0000-\u001f\u007f]/.test(args.url)) return "url";
  let parsedProtocol: string;
  try {
    parsedProtocol = new URL(args.url).protocol;
  } catch {
    return "url";
  }
  if (parsedProtocol !== "http:" && parsedProtocol !== "https:") return "url";

  // maxBytes: optional integer in [MIN_MAX_BYTES, MAX_MAX_BYTES]
  // (Requirements 2.2, 2.13).
  if (args.maxBytes !== undefined) {
    if (
      typeof args.maxBytes !== "number" ||
      !Number.isInteger(args.maxBytes) ||
      args.maxBytes < MIN_MAX_BYTES ||
      args.maxBytes > MAX_MAX_BYTES
    ) {
      return "maxBytes";
    }
  }

  // includeHeaders / includeTls / includeTiming / includeRedirectChain:
  // optional booleans (Requirement 2.34). `validateArgs` checks them in
  // the order they appear in `WebFetchArgs`.
  if (
    args.includeHeaders !== undefined &&
    typeof args.includeHeaders !== "boolean"
  ) {
    return "includeHeaders";
  }
  if (args.includeTls !== undefined && typeof args.includeTls !== "boolean") {
    return "includeTls";
  }
  if (
    args.includeTiming !== undefined &&
    typeof args.includeTiming !== "boolean"
  ) {
    return "includeTiming";
  }
  if (
    args.includeRedirectChain !== undefined &&
    typeof args.includeRedirectChain !== "boolean"
  ) {
    return "includeRedirectChain";
  }

  // responseMode: optional, must equal "readable" or "raw" (Requirement
  // 2.33).
  if (args.responseMode !== undefined) {
    if (
      typeof args.responseMode !== "string" ||
      (args.responseMode !== "readable" && args.responseMode !== "raw")
    ) {
      return "responseMode";
    }
  }

  // redactSensitive: optional boolean (Requirement 2.34).
  if (
    args.redactSensitive !== undefined &&
    typeof args.redactSensitive !== "boolean"
  ) {
    return "redactSensitive";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 3: web.fetch input validation", () => {
  it("returns ok=true exactly when every argument satisfies its declared type/range; otherwise ok=false with an error naming the offending argument", async () => {
    const stub = makeFetchStub();

    await fc.assert(
      fc.asyncProperty(argsArb, async (rawArgs) => {
        const expectedOffender = offendingArgument(rawArgs);

        // The tuple is passed to `webFetchCore` *unchanged* — the type
        // assertion lets us hand a RawArgs shape (which intentionally
        // carries `unknown` field types) to the public API that expects
        // `WebFetchArgs`. The whole point of the property is that invalid
        // shapes are rejected at the door.
        const outcome = await webFetchCore(rawArgs as never, stub);

        if (expectedOffender === null) {
          // Every argument is valid; the stub returns 200 OK so the
          // pipeline reaches the success branch.
          expect(outcome.ok).toBe(true);
          expect(outcome.error).toBeUndefined();
          return;
        }

        // Invalid input: outcome must be ok=false.
        expect(outcome.ok).toBe(false);
        expect(outcome.error).toBeDefined();
        const err = outcome.error;
        if (err === undefined) return; // narrowed for the type checker

        // The validator emits one of two error kinds for argument
        // failures:
        //   - "validation"     for type/range violations and url
        //                      shape rules (empty / whitespace /
        //                      control chars / unparseable)
        //   - "blocked-scheme" for url scheme allowlist violations
        //                      (Requirement 2.1 / 5.4)
        // Both kinds count as "argument validation" for this property.
        expect(["validation", "blocked-scheme"]).toContain(err.kind);

        // Error message must name the offending argument *or*, in the
        // bad-scheme case, identify the rejected scheme + carry the
        // url on the error object so callers can attribute the failure
        // to the `url` argument (Requirement 2.12).
        if (expectedOffender === "url") {
          const looksLikeUrlError =
            err.kind === "blocked-scheme" ||
            /url/i.test(err.message) ||
            err.url === rawArgs.url;
          expect(looksLikeUrlError).toBe(true);
        } else {
          expect(err.kind).toBe("validation");
          // Other-argument violations always include the argument name
          // verbatim in the error message.
          expect(err.message).toContain(expectedOffender);
        }
      }),
      { numRuns: 100 },
    );
  });
});
