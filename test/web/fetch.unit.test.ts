// Feature: web-search-and-fetch, Task 5.5: web.fetch behavior unit tests
//
// Covers:
//   • Requirement 2.3: a successful GET against a stubbed
//     https://example.com round-trip yields ok=true with the body
//     visible in the rendered output.
//   • Requirement 2.10: the 30-second timeout aborts via the
//     AbortController and surfaces error.kind="timeout" — exercised
//     with `vi.useFakeTimers` so the test does not actually sleep.
//   • Requirement 6.4: a 4xx HTTP error produces error.kind="http-error"
//     with a body preview clamped to ≤ 4096 bytes.
//   • Requirement 2.9: a binary content type produces
//     error.kind="binary-content".
//   • Requirement 5.3: an `https://127.0.0.1` literal is blocked at the
//     classifier with level="block".

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { webFetch } from "../../src/tools/web/fetch.js";
import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import { classifyToolCall } from "../../src/safety/classifier.js";
import {
  HTTP_ERROR_BODY_PREVIEW_BYTES,
  TRUNCATION_MARKER,
} from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// HTTP stubs
// ---------------------------------------------------------------------------

interface StubOptions {
  status: number;
  contentType: string;
  body: Buffer;
}

function buildHttpsStub(opts: StubOptions): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
} {
  const httpsRequest = (_url: string | URL, _options: unknown): ClientRequest => {
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        const socket = new EventEmitter() as unknown as {
          getProtocol: () => string;
          getCipher: () => { name: string };
          getPeerCertificate: () => Record<string, unknown>;
          emit: (...a: unknown[]) => void;
          once: (...a: unknown[]) => void;
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
        res.statusCode = opts.status;
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
  return { httpsRequest };
}

const dnsLookup = async (
  _host: string,
  _o: unknown,
): Promise<{ address: string; family: number }> => ({
  address: "93.184.216.34",
  family: 4,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("web.fetch unit tests", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds against a stubbed https://example.com (Requirement 2.3)", async () => {
    const body = Buffer.from(
      "<html><body><h1>Welcome</h1></body></html>",
      "utf-8",
    );
    const { httpsRequest } = buildHttpsStub({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body,
    });

    const result = await webFetch(
      { url: "https://example.com/", responseMode: "raw" },
      { core: { httpsRequest, dnsLookup } },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://example.com/");
    expect(result.output).toContain("200");
    expect(result.output).toContain("text/html");
    expect(result.output).toContain("<h1>Welcome</h1>");
  });

  it("surfaces error.kind=http-error with a ≤4096-byte body preview on 4xx (Requirement 6.4)", async () => {
    // Build a body big enough to force preview truncation.
    const giantBody = Buffer.alloc(HTTP_ERROR_BODY_PREVIEW_BYTES + 2048, 0x41);
    const { httpsRequest } = buildHttpsStub({
      status: 404,
      contentType: "text/html",
      body: giantBody,
    });

    const result = await webFetchCore(
      { url: "https://example.com/missing" },
      { httpsRequest, dnsLookup },
    );

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("http-error");
    expect(result.error?.status).toBe(404);
    expect(result.error?.url).toBe("https://example.com/missing");
    // The body preview is decoded UTF-8 with replacement and is
    // capped at HTTP_ERROR_BODY_PREVIEW_BYTES followed by the
    // truncation marker.
    expect(result.error?.bodyPreview?.endsWith(TRUNCATION_MARKER)).toBe(true);
    const previewBytes = Buffer.byteLength(
      (result.error?.bodyPreview ?? "").replace(TRUNCATION_MARKER, ""),
      "utf-8",
    );
    expect(previewBytes).toBeLessThanOrEqual(HTTP_ERROR_BODY_PREVIEW_BYTES);
  });

  it("rejects binary content types regardless of responseMode (Requirement 2.9 + 2.30)", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { httpsRequest } = buildHttpsStub({
      status: 200,
      contentType: "image/png",
      body: png,
    });
    for (const mode of ["readable", "raw"] as const) {
      const result = await webFetchCore(
        { url: "https://example.com/icon.png", responseMode: mode },
        { httpsRequest, dnsLookup },
      );
      expect(result.ok).toBe(false);
      expect(result.error?.kind).toBe("binary-content");
      expect(result.error?.message).toContain("image/png");
    }
  });

  it("classifier blocks https://127.0.0.1 literally before any I/O (Requirement 5.3)", () => {
    const decision = classifyToolCall({
      name: "web.fetch",
      args: { url: "https://127.0.0.1/admin" },
    });
    expect(decision.level).toBe("block");
    expect(decision.reason.toLowerCase()).toContain("loopback");
  });

  it("the 30-second wall-clock timer aborts the request via AbortController (Requirement 2.10)", async () => {
    vi.useFakeTimers();

    // Build a stub that NEVER emits a response so the only path to
    // settlement is the AbortController-driven timeout.
    const httpsRequest = (_url: string | URL, _options: unknown): ClientRequest => {
      const req = new EventEmitter() as unknown as ClientRequest;
      (req as unknown as { end: () => void }).end = (): void => {
        // Do not emit any events. The orchestrator's request listener
        // is wired via the AbortController signal — when the timer
        // fires, the controller aborts and the request emits "error"
        // with name="AbortError". We mimic that by attaching an
        // abort listener.
      };
      // Wire the abort propagation manually so the orchestrator's
      // `signal: ctx.controller.signal` triggers an `error` event on
      // the request.
      const options = _options as { signal?: AbortSignal } | undefined;
      const sig = options?.signal;
      if (sig) {
        sig.addEventListener("abort", () => {
          queueMicrotask(() => {
            const err = new Error("aborted");
            (err as Error & { name: string }).name = "AbortError";
            (req as unknown as { emit: (...a: unknown[]) => void }).emit(
              "error",
              err,
            );
          });
        });
      }
      return req;
    };

    // Kick off the fetch but do not await yet — we need to advance
    // the timers first.
    const promise = webFetchCore(
      { url: "https://example.com/" },
      { httpsRequest, dnsLookup },
    );

    // Run scheduled microtasks so the request is dispatched.
    await vi.runOnlyPendingTimersAsync();
    // Advance past the 30-second timeout to fire the abort.
    await vi.advanceTimersByTimeAsync(31_000);

    const result = await promise;

    expect(result.ok).toBe(false);
    expect(result.error?.kind).toBe("timeout");
    expect(result.error?.message).toContain("timeout after 30s");
  });
});
