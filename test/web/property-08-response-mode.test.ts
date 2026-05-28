// Feature: web-search-and-fetch, Property 8: responseMode governs body shape
//
// Validates: Requirements 2.4, 2.5, 2.28, 2.29
//
// For arbitrary `(body, contentType, responseMode)` triples with non-binary
// content types:
//
//   1. In `readable` mode AND content type matches `text/html` or
//      `application/xhtml+xml`, the returned body contains no `<script>`,
//      `<style>`, `<noscript>`, or HTML comment substrings.
//
//   2. In `readable` mode AND a non-HTML text content type, the returned
//      body equals the source bytes decoded as UTF-8 (with replacement),
//      truncated at `maxBytes`.
//
//   3. In `raw` mode, the returned body equals the source bytes decoded as
//      UTF-8 (with replacement), truncated at `maxBytes`, regardless of
//      whether the content type is HTML/XHTML or plain text. `metadata.mode`
//      equals `"raw"`.
//
// The fetch core is exercised through its injectable transport
// (`httpsRequest` + `dnsLookup`) so no real network I/O happens. The DNS
// stub returns a public IP (example.com → 93.184.216.34) so the SSRF guard
// does not reject the connection.

import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import fc from "fast-check";

import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import { MIN_MAX_BYTES } from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// HTTP stub
// ---------------------------------------------------------------------------

interface StubOptions {
  body: Buffer;
  contentType: string;
}

/**
 * Build an in-process replacement for `https.request` that drives the
 * {@link webFetchCore} pipeline through one terminal hop returning a
 * 200 with the configured `Content-Type` and body bytes.
 *
 * The companion `dnsLookup` resolves to a publicly-routable IPv4 address
 * (`93.184.216.34`, the canonical example.com IP) so the SSRF guard does
 * not reject the connection.
 */
function makeFetchStub(opts: StubOptions): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
  dnsLookup: (
    host: string,
    o: unknown,
  ) => Promise<{ address: string; family: number }>;
} {
  const httpsRequest = (
    _url: string | URL,
    _options: unknown,
  ): ClientRequest => {
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        // Fake TLS socket — `Capture.markTlsHandshaked` calls a few
        // methods on it during the handshake event flow. Provide
        // enough surface to satisfy them.
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
    address: "93.184.216.34",
    family: 4,
  });

  return { httpsRequest, dnsLookup };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/**
 * "Safe" visible-text alphabet — alphanumerics, common punctuation, and
 * whitespace, but no `<`, `>`, `&`, or `!`. Used in HTML text nodes to
 * guarantee that any `<script>`/`<style>`/`<noscript>`/`<!--` substring
 * appearing in the *generated* document came from a real HTML construct
 * we placed there, not from accidental text content. Without this
 * restriction, fast-check could trivially defeat the property by
 * generating literal `<script>` text inside a `<p>` element.
 */
const safeTextArb = fc.stringMatching(/^[A-Za-z0-9 .,?:;'"\n\t]{0,64}$/);

/**
 * Content typically nested inside `<script>` / `<style>` tags. Restricted
 * to alphanumerics and common JS/CSS punctuation that cannot accidentally
 * form a `</script>` or `</style>` closing token (which would let the
 * parser bail early and surface the script body as visible text).
 */
const tagInteriorArb = fc.stringMatching(/^[A-Za-z0-9 .,;:(){}=+\-*/_]{0,64}$/);

/**
 * Comment content. Must not contain `--` because that would let an HTML
 * tokenizer prematurely close the comment.
 */
const commentInteriorArb = fc.stringMatching(/^[A-Za-z0-9 .,;:()_]{0,64}$/);

/**
 * HTML document arbitrary that intermixes `<script>`, `<style>`,
 * `<noscript>`, and HTML comment nodes with plain text paragraphs. Each
 * non-content block is wrapped in optional placement so different runs
 * exercise different combinations.
 */
const htmlBodyArb = fc
  .tuple(
    safeTextArb, // before-text
    fc.option(tagInteriorArb, { nil: undefined }),
    fc.option(tagInteriorArb, { nil: undefined }),
    fc.option(tagInteriorArb, { nil: undefined }),
    fc.option(commentInteriorArb, { nil: undefined }),
    safeTextArb, // after-text
  )
  .map(([before, scriptC, styleC, noscriptC, commentC, after]) => {
    const parts: string[] = [
      "<!doctype html><html><head>",
    ];
    if (scriptC !== undefined) parts.push(`<script>${scriptC}</script>`);
    if (styleC !== undefined) parts.push(`<style>${styleC}</style>`);
    parts.push(`<title>t</title></head><body><p>${before}</p>`);
    if (noscriptC !== undefined) parts.push(`<noscript>${noscriptC}</noscript>`);
    if (commentC !== undefined) parts.push(`<!--${commentC}-->`);
    parts.push(`<p>${after}</p></body></html>`);
    return parts.join("");
  });

/** Plain-text body arbitrary — any printable ASCII string (no `<`/`>`). */
const plainTextBodyArb = fc.stringMatching(/^[\x20-\x3B\x3D\x3F-\x7E\n\t]{0,512}$/);

/** Content types that route through the HTML-to-readable-text branch. */
const htmlContentTypeArb = fc.constantFrom(
  "text/html",
  "text/html; charset=utf-8",
  "text/html;charset=utf-8",
  "application/xhtml+xml",
  "application/xhtml+xml; charset=utf-8",
);

/** Non-HTML text content types — passthrough in readable mode. */
const plainContentTypeArb = fc.constantFrom(
  "text/plain",
  "text/plain; charset=utf-8",
  "application/json",
  "application/json; charset=utf-8",
  "text/markdown",
  "text/markdown; charset=utf-8",
  "text/csv",
);

/**
 * Valid `maxBytes` values constrained to a small range so each property run
 * stays fast. Matches the bounds used in adjacent fetch-core property tests.
 */
const arbMaxBytes = fc.integer({ min: MIN_MAX_BYTES, max: 4096 });

// ---------------------------------------------------------------------------
// Decode oracle (matches `decodeUtf8WithReplacement` in `fetch-core.ts`).
// ---------------------------------------------------------------------------

function decodeUtf8WithReplacement(buf: Buffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe("Property 8: responseMode governs body shape", () => {
  it("readable mode + HTML/XHTML strips <script>/<style>/<noscript>/<!-- substrings", async () => {
    await fc.assert(
      fc.asyncProperty(
        htmlBodyArb,
        htmlContentTypeArb,
        async (html, contentType) => {
          const body = Buffer.from(html, "utf-8");
          // Use a `maxBytes` comfortably larger than every generated body
          // so this property is about HTML conversion, not truncation.
          const stub = makeFetchStub({ body, contentType });

          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              maxBytes: 8192,
              responseMode: "readable",
            },
            stub,
          );

          expect(outcome.ok).toBe(true);
          expect(outcome.metadata.mode).toBe("readable");
          expect(outcome.body).not.toContain("<script>");
          expect(outcome.body).not.toContain("<style>");
          expect(outcome.body).not.toContain("<noscript>");
          // Comment markers — both ends, since either presence would
          // indicate the comment node survived stripping.
          expect(outcome.body).not.toContain("<!--");
          expect(outcome.body).not.toContain("-->");
        },
      ),
      { numRuns: 100 },
    );
  });

  it("readable mode + non-HTML text returns the source bytes decoded as UTF-8 up to maxBytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        plainTextBodyArb,
        plainContentTypeArb,
        arbMaxBytes,
        async (text, contentType, maxBytes) => {
          const body = Buffer.from(text, "utf-8");
          const expected = decodeUtf8WithReplacement(
            body.subarray(0, Math.min(body.byteLength, maxBytes)),
          );

          const stub = makeFetchStub({ body, contentType });
          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              maxBytes,
              responseMode: "readable",
            },
            stub,
          );

          expect(outcome.ok).toBe(true);
          expect(outcome.metadata.mode).toBe("readable");
          expect(outcome.body).toBe(expected);
          // Belt-and-suspenders: bytesReceived honors the cap.
          expect(outcome.metadata.bytesReceived).toBeLessThanOrEqual(maxBytes);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("raw mode returns UTF-8 decoded source bytes truncated at maxBytes with metadata.mode === 'raw'", async () => {
    // Raw mode is content-type independent (apart from the binary
    // rejection covered separately by Property 9). Mix HTML and
    // plain-text bodies so both code paths through `classifyAndDecodeBody`
    // are exercised — for raw, both must collapse to the same decode.
    const bodyArb = fc.oneof(htmlBodyArb, plainTextBodyArb);
    const contentTypeArb = fc.oneof(htmlContentTypeArb, plainContentTypeArb);

    await fc.assert(
      fc.asyncProperty(
        bodyArb,
        contentTypeArb,
        arbMaxBytes,
        async (text, contentType, maxBytes) => {
          const body = Buffer.from(text, "utf-8");
          const expected = decodeUtf8WithReplacement(
            body.subarray(0, Math.min(body.byteLength, maxBytes)),
          );

          const stub = makeFetchStub({ body, contentType });
          const outcome = await webFetchCore(
            {
              url: "https://example.com/",
              maxBytes,
              responseMode: "raw",
            },
            stub,
          );

          expect(outcome.ok).toBe(true);
          expect(outcome.metadata.mode).toBe("raw");
          expect(outcome.body).toBe(expected);
          expect(outcome.metadata.bytesReceived).toBeLessThanOrEqual(maxBytes);
          expect(outcome.metadata.bytesReceived).toBe(
            Math.min(body.byteLength, maxBytes),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
