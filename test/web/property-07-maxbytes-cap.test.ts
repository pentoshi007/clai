// Feature: web-search-and-fetch, Property 7: maxBytes cap honored before HTML conversion
//
// Validates: Requirements 2.7
//
// For arbitrary body bytes and any valid `maxBytes`:
//   1. `metadata.bytesReceived` is always ≤ `maxBytes`.
//   2. `metadata.truncated` is `true` iff the body length exceeded `maxBytes`.
//   3. The readable-text conversion only ever sees bytes that were already
//      truncated to `maxBytes` — so any unique sentinel placed past byte
//      `maxBytes` of an HTML body cannot appear in the readable-mode output.
//
// The fetch core is exercised through its injectable transport (`httpsRequest`
// + `dnsLookup`) so no real network I/O happens. The HTTP stub emits a body
// buffer whose size we control via fast-check arbitraries.

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import fc from "fast-check";

import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import {
  MIN_MAX_BYTES,
  type ResponseMode,
} from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

interface StubOptions {
  body: Buffer;
  contentType: string;
}

/**
 * Build a deterministic in-process replacement for `https.request` that
 * drives the {@link webFetchCore} pipeline through one terminal hop:
 *
 *   1. Emit `socket` with a fake `TLSSocket` once `req.end()` is called.
 *   2. Emit `connect` and `secureConnect` on the socket so timing capture
 *      records non-zero values.
 *   3. Emit `response` with a fake `IncomingMessage` carrying a 200 status
 *      and the configured Content-Type header.
 *   4. Emit a single `data` chunk of {@link StubOptions.body} bytes followed
 *      by `end` so {@link readBody} settles.
 *
 * Returned alongside the stub is a {@link DnsLookupFn} that resolves to a
 * publicly-routable IPv4 address so the SSRF guard does not reject the
 * resolved IP.
 */
function makeFetchStub(opts: StubOptions): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
  dnsLookup: (
    host: string,
    o: unknown,
  ) => Promise<{ address: string; family: number }>;
} {
  const httpsRequest = (_url: string | URL, _options: unknown): ClientRequest => {
    const req = new EventEmitter() as unknown as ClientRequest;
    // `end` is the only ClientRequest method webFetchCore calls. We override
    // it to schedule the synthetic socket/response event flow on the next
    // microtask so the caller has time to attach listeners first.
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        // Fake TLS socket. The `getProtocol`/`getCipher`/`getPeerCertificate`
        // methods are required by `Capture.markTlsHandshaked` — `Capture`
        // never inspects a missing socket, but the listener wires fire
        // unconditionally so we provide enough surface to satisfy them.
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

        // Fake IncomingMessage. `resume`/`destroy` are stubbed because
        // readBody calls `res.destroy()` on the truncation path.
        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          headers: Record<string, string>;
          resume: () => void;
          destroy: () => void;
        };
        res.statusCode = 200;
        res.headers = { "content-type": opts.contentType };
        res.resume = () => {};
        res.destroy = () => {};

        (req as unknown as { emit: (...a: unknown[]) => void }).emit(
          "response",
          res,
        );

        // Emit the body in a single chunk on a later microtask so
        // webFetchCore has time to attach `data`/`end` listeners.
        queueMicrotask(() => {
          (res as { emit: (...a: unknown[]) => void }).emit("data", opts.body);
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
    // Public IP for example.com — guaranteed not to fall in any SSRF class.
    address: "93.184.216.34",
    family: 4,
  });

  return { httpsRequest, dnsLookup };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * Valid `maxBytes` values constrained to a small range so each property run
 * stays fast. We intentionally keep the upper end well below the production
 * cap: the invariants under test are independent of the cap's absolute size.
 */
const arbMaxBytes = fc.integer({ min: MIN_MAX_BYTES, max: 4096 });

/**
 * Arbitrary body length spanning empty, exactly-at-cap, and well-past-cap.
 * The upper bound is 2×max so we get a healthy mix of truncated/non-truncated
 * runs in the 100+ executions.
 */
const arbBodyLength = fc.integer({ min: 0, max: 8192 });

/** `responseMode` is sampled uniformly between the two valid options. */
const arbResponseMode: fc.Arbitrary<ResponseMode> = fc.constantFrom(
  "raw",
  "readable",
);

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 7: maxBytes cap and truncation are honored before HTML conversion", () => {
  it("bytesReceived ≤ maxBytes and truncated reflects body.length > maxBytes (raw + readable, non-HTML)", async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMaxBytes,
        arbBodyLength,
        arbResponseMode,
        async (maxBytes, bodyLength, responseMode) => {
          // `text/plain` so neither mode runs through `toReadableText`. The
          // first invariant (bytesReceived ≤ maxBytes) is content-type
          // independent and therefore cleanest to test on plain text.
          const body = Buffer.alloc(bodyLength, 0x61); // ASCII 'a'
          const stub = makeFetchStub({
            body,
            contentType: "text/plain; charset=utf-8",
          });

          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              maxBytes,
              responseMode,
            },
            stub,
          );

          expect(outcome.ok).toBe(true);
          expect(outcome.metadata.bytesReceived).toBeLessThanOrEqual(maxBytes);
          expect(outcome.metadata.bytesReceived).toBe(
            Math.min(bodyLength, maxBytes),
          );
          expect(outcome.metadata.truncated).toBe(bodyLength > maxBytes);

          // Body string honors the cap too — for ASCII bytes UTF-8 decoded
          // produces one JS code unit per byte, so the string length must
          // not exceed `bytesReceived`.
          expect(outcome.body.length).toBeLessThanOrEqual(
            outcome.metadata.bytesReceived,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it("readable HTML conversion only sees bytes already truncated to maxBytes (sentinel placed past the cap never leaks)", async () => {
    /**
     * A unique marker we splice in *after* the `maxBytes` boundary. If the
     * pipeline ran HTML conversion on the un-truncated body the marker would
     * surface in `outcome.body` (it's plain ASCII text wrapped in a `<p>`
     * element so cheerio cannot strip it as chrome). We assert it never does.
     */
    const SENTINEL = "ZSENTINEL_SHOULD_NEVER_APPEAR_IN_OUTPUT_42";

    await fc.assert(
      fc.asyncProperty(
        arbMaxBytes,
        // Force `bodyLength > maxBytes` so the sentinel is always placed past
        // the cap — this is the branch that the property is actually about.
        fc.integer({ min: 1, max: 4096 }),
        async (maxBytes, extraBytes) => {
          const bodyLength = maxBytes + extraBytes + SENTINEL.length;

          // First `maxBytes` bytes: HTML body whose visible text never
          // contains any character of the sentinel. Use a single ASCII char
          // ('q') so any leakage of post-cap bytes shows up unambiguously.
          const headFiller = "q".repeat(maxBytes);
          const head = Buffer.from(headFiller, "utf-8").subarray(0, maxBytes);

          // Tail: sentinel followed by enough filler to reach `bodyLength`.
          const tailFiller = "z".repeat(Math.max(0, extraBytes));
          const tail = Buffer.from(`${SENTINEL}${tailFiller}`, "utf-8");

          const body = Buffer.concat([head, tail]);
          // Sanity: head ends exactly at the maxBytes boundary.
          expect(body.byteLength).toBeGreaterThan(maxBytes);

          const stub = makeFetchStub({
            body,
            contentType: "text/html; charset=utf-8",
          });

          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              maxBytes,
              responseMode: "readable",
            },
            stub,
          );

          expect(outcome.ok).toBe(true);

          // Truncation invariants restated for the HTML branch.
          expect(outcome.metadata.bytesReceived).toBe(maxBytes);
          expect(outcome.metadata.truncated).toBe(true);

          // The sentinel sits entirely past the cap; readable conversion ran
          // on the truncated head buffer so the marker cannot appear.
          expect(outcome.body).not.toContain(SENTINEL);
          // Defensive: the marker prefix alone (without the suffix) also
          // must not appear, otherwise post-cap bytes leaked partially.
          expect(outcome.body).not.toContain("ZSENTINEL");
        },
      ),
      { numRuns: 100 },
    );
  });
});
