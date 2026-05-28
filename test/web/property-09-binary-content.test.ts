// Feature: web-search-and-fetch, Property 9: Binary content types are always rejected
//
// Validates: Requirements 2.9, 2.30
//
// For any response whose Content-Type matches `image/*`, `application/octet-stream`,
// `application/pdf`, or `video/*`, AND for any `responseMode` (readable or raw),
// the `web.fetch` pipeline must surface `ok=false` with `error.kind="binary-content"`
// and an error message that names the unsupported content type. The check applies
// before any body bytes are decoded so `responseMode="raw"` does not bypass it
// (Requirement 2.30).
//
// The pipeline runs through `webFetchCore` with stubbed `httpsRequest` and
// `dnsLookup` so no network I/O happens. DNS resolves to a public IP
// (93.184.216.34, example.com) so the SSRF guard does not short-circuit before
// the response phase, and the request URL uses example.com so the hostname
// classifier passes.

import { EventEmitter } from "node:events";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  IncomingMessage,
} from "node:http";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  webFetchCore,
  type DnsLookupFn,
  type HttpsRequestFn,
} from "../../src/tools/web/fetch-core.js";
import type { ResponseMode } from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * MIME subtype token generator. Restricted to the RFC 6838 token charset so
 * the resulting Content-Type stays parseable and round-trips through the
 * pipeline's `headerString` / `BINARY_CONTENT_TYPE_PATTERNS` checks
 * unmodified.
 */
const mimeSubtypeArb = fc
  .stringMatching(/^[a-zA-Z0-9.+\-]{1,24}$/)
  .filter((s) => s.length > 0);

/**
 * Generator covering every binary Content-Type prefix listed in Requirement
 * 2.9 plus arbitrary subtypes:
 *
 *   - `image/<subtype>`                — matches `^image\//i`
 *   - `video/<subtype>`                — matches `^video\//i`
 *   - `application/octet-stream[suf]`  — matches `^application/octet-stream/i`
 *   - `application/pdf[suf]`           — matches `^application/pdf/i`
 *
 * Plus a handful of canonical real-world examples so the property does not
 * need to rediscover them every run via shrinking.
 */
const binaryContentTypeArb = fc.oneof(
  mimeSubtypeArb.map((s) => `image/${s}`),
  mimeSubtypeArb.map((s) => `video/${s}`),
  mimeSubtypeArb.map((s) => `application/octet-stream+${s}`),
  fc.constant("application/octet-stream"),
  mimeSubtypeArb.map((s) => `application/pdf+${s}`),
  fc.constant("application/pdf"),
  fc.constantFrom(
    "image/png",
    "image/gif",
    "image/jpeg",
    "image/webp",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "video/quicktime",
  ),
);

/** Both supported response modes plus `undefined` to cover the default. */
const responseModeArb = fc.oneof(
  fc.constant<ResponseMode | undefined>(undefined),
  fc.constant<ResponseMode | undefined>("readable"),
  fc.constant<ResponseMode | undefined>("raw"),
);

/**
 * Charset / parameter suffix appended after the base content type. Exercises
 * the prefix-anchored regex behaviour (e.g. `image/png; charset=utf-8` must
 * still match `^image\//i`).
 */
const charsetSuffixArb = fc.oneof(
  fc.constant(""),
  fc.constant("; charset=utf-8"),
  fc.constant(";charset=binary"),
  fc.constant("; boundary=---x"),
);

// ---------------------------------------------------------------------------
// Transport stubs
// ---------------------------------------------------------------------------

/**
 * Build a fake `https.request` that emits a synthetic 200 response carrying
 * the given Content-Type. The response body is never read because the binary
 * branch in `fetch-core.ts` calls `res.resume()` and short-circuits before
 * `readBody` runs — but we still expose `resume()` as a no-op so the
 * pipeline is happy.
 */
function makeBinaryHttpsStub(contentType: string): HttpsRequestFn {
  return function fakeHttpsRequest(_url, _options): ClientRequest {
    const req = new EventEmitter() as ClientRequest;
    // `req.end()` is the last thing `issueHop` calls before awaiting events.
    (req as unknown as { end: () => void }).end = () => {};

    // Drive the event sequence on `setImmediate` so the synchronous
    // listener registration in `issueHop` (req.on('socket'), req.on('response'),
    // req.on('error')) completes before any event fires.
    setImmediate(() => {
      const socket = makeFakeTlsSocket();
      req.emit("socket", socket as unknown as Socket);

      setImmediate(() => {
        socket.emit("connect");
        setImmediate(() => {
          socket.emit("secureConnect");
          setImmediate(() => {
            const res = makeFakeResponse(contentType);
            req.emit("response", res);
          });
        });
      });
    });

    return req;
  };
}

/**
 * Minimal `tls.TLSSocket` stub: an EventEmitter plus the three accessors
 * that `Capture.markTlsHandshaked` reads (`getProtocol`, `getCipher`,
 * `getPeerCertificate`). The peer-certificate fields are intentionally
 * blank — they go unread on the binary-content path because that path
 * fails before TLS info reaches the metadata budget.
 */
function makeFakeTlsSocket(): EventEmitter & TLSSocket {
  const socket = new EventEmitter() as EventEmitter & TLSSocket;
  (socket as unknown as { getProtocol: () => string }).getProtocol = () =>
    "TLSv1.3";
  (socket as unknown as { getCipher: () => { name: string } }).getCipher =
    () => ({ name: "TLS_AES_128_GCM_SHA256" });
  (
    socket as unknown as {
      getPeerCertificate: () => Record<string, unknown>;
    }
  ).getPeerCertificate = () => ({});
  return socket;
}

/**
 * Minimal `IncomingMessage` stub carrying a 200 status and the desired
 * Content-Type. `resume()` is a no-op so the binary branch's drain call
 * does not throw; `data`/`end` listeners are never invoked because the
 * pipeline never reaches `readBody` on the binary path.
 */
function makeFakeResponse(contentType: string): IncomingMessage {
  const res = new EventEmitter() as IncomingMessage;
  const headers: IncomingHttpHeaders = { "content-type": contentType };
  (res as unknown as { statusCode: number }).statusCode = 200;
  (res as unknown as { headers: IncomingHttpHeaders }).headers = headers;
  (res as unknown as { resume: () => void }).resume = () => {};
  return res;
}

/**
 * DNS stub returning a public IP (example.com's canonical address). The
 * SSRF classifier accepts any address outside loopback / RFC1918 /
 * link-local / cloud-metadata / CGNAT, so the pipeline reaches the
 * response-handling phase where the binary check lives.
 */
const publicIpDnsLookup: DnsLookupFn = async () => ({
  address: "93.184.216.34",
  family: 4,
});

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe("Property 9: Binary content types are always rejected", () => {
  it("returns ok=false / error.kind='binary-content' for every binary content type and any responseMode", async () => {
    await fc.assert(
      fc.asyncProperty(
        binaryContentTypeArb,
        charsetSuffixArb,
        responseModeArb,
        async (baseType, charsetSuffix, responseMode) => {
          const fullContentType = `${baseType}${charsetSuffix}`;

          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              ...(responseMode !== undefined ? { responseMode } : {}),
            },
            {
              httpsRequest: makeBinaryHttpsStub(fullContentType),
              dnsLookup: publicIpDnsLookup,
            },
          );

          // ok=false with the categorical kind defined by Requirement 2.9.
          expect(outcome.ok).toBe(false);
          expect(outcome.error).toBeDefined();
          expect(outcome.error?.kind).toBe("binary-content");

          // Error message names the unsupported content type so callers can
          // surface it to the agent / audit log unmodified.
          expect(typeof outcome.error?.message).toBe("string");
          expect(outcome.error?.message).toContain(fullContentType);

          // The pipeline reached the response phase, so the recorded status
          // matches the synthetic response's 200.
          expect(outcome.error?.status).toBe(200);

          // Body is never decoded on the binary path — neither in
          // readable nor raw mode (Requirement 2.30).
          expect(outcome.body).toBe("");
        },
      ),
      { numRuns: 100 },
    );
  });
});
