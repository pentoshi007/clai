// Feature: web-search-and-fetch, Property 17: Single-attempt invariant
//
// Validates: Requirements 6.7
//
// For arbitrary failing invocations of both `webSearch` and `webFetch`,
// the underlying outbound transport is invoked exactly once. We
// inject a counting stub for the provider transport (search) and the
// HTTPS transport (fetch); after the failing invocation completes,
// the counter must read exactly 1.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { webSearch } from "../../src/tools/web/search.js";
import { webFetchCore } from "../../src/tools/web/fetch-core.js";
import type {
  RawProviderResponse,
  SearchProvider,
} from "../../src/tools/web/providers/provider.js";

// ---------------------------------------------------------------------------
// Search half
// ---------------------------------------------------------------------------

function makeCountingProvider(raw: RawProviderResponse): {
  provider: SearchProvider;
  counter: { calls: number };
} {
  const counter = { calls: 0 };
  const provider: SearchProvider = {
    id: "duckduckgo",
    displayName: "DuckDuckGo",
    needsApiKey: false,
    async search(): Promise<RawProviderResponse> {
      counter.calls += 1;
      return raw;
    },
  };
  return { provider, counter };
}

function makeThrowingProvider(): {
  provider: SearchProvider;
  counter: { calls: number };
} {
  const counter = { calls: 0 };
  const provider: SearchProvider = {
    id: "duckduckgo",
    displayName: "DuckDuckGo",
    needsApiKey: false,
    async search(): Promise<RawProviderResponse> {
      counter.calls += 1;
      throw new Error("network unavailable");
    },
  };
  return { provider, counter };
}

describe("Property 17: webSearch single-attempt invariant", () => {
  it("provider.search is invoked exactly once on every failing outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<RawProviderResponse | "throw">(
          { status: 401, hits: [] },
          { status: 429, hits: [] },
          { status: 500, hits: [] },
          { status: 503, hits: [] },
          { status: 418, hits: [] },
          { status: 200, hits: [], parseError: "non-JSON response" },
          "throw",
        ),
        async (failureMode) => {
          const { provider, counter } =
            failureMode === "throw"
              ? makeThrowingProvider()
              : makeCountingProvider(failureMode);
          const result = await webSearch(
            { query: "single-attempt-test" },
            { provider: "duckduckgo", providerOverride: provider },
          );
          expect(result.ok).toBe(false);
          expect(counter.calls).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Fetch half
// ---------------------------------------------------------------------------

function buildFailingHttpsStub(failure: {
  kind: "throw" | "5xx" | "4xx";
}): {
  httpsRequest: (url: string | URL, options: unknown) => ClientRequest;
  counter: { calls: number };
} {
  const counter = { calls: 0 };
  const httpsRequest = (_url: string | URL, _options: unknown): ClientRequest => {
    counter.calls += 1;
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        if (failure.kind === "throw") {
          (req as unknown as { emit: (...a: unknown[]) => void }).emit(
            "error",
            new Error("connection refused"),
          );
          return;
        }
        const socket = new EventEmitter() as unknown as {
          getProtocol: () => string;
          getCipher: () => { name: string };
          getPeerCertificate: () => Record<string, unknown>;
          emit: (...a: unknown[]) => void;
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
        res.statusCode = failure.kind === "5xx" ? 503 : 404;
        res.headers = { "content-type": "text/plain" };
        res.resume = () => {};
        res.destroy = () => {};

        (req as unknown as { emit: (...a: unknown[]) => void }).emit(
          "response",
          res,
        );
        queueMicrotask(() => {
          (res as { emit: (...a: unknown[]) => void }).emit(
            "data",
            Buffer.from("nope", "utf-8"),
          );
          (res as { emit: (...a: unknown[]) => void }).emit("end");
        });
      });
    };
    return req;
  };
  return { httpsRequest, counter };
}

const publicDns = async (
  _h: string,
  _o: unknown,
): Promise<{ address: string; family: number }> => ({
  address: "93.184.216.34",
  family: 4,
});

describe("Property 17: webFetchCore single-attempt invariant", () => {
  it("transport is invoked exactly once on every failing outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<{ kind: "throw" | "5xx" | "4xx" }>(
          { kind: "throw" },
          { kind: "5xx" },
          { kind: "4xx" },
        ),
        async (failure) => {
          const { httpsRequest, counter } = buildFailingHttpsStub(failure);
          const result = await webFetchCore(
            { url: "https://example.com/" },
            { httpsRequest, dnsLookup: publicDns },
          );
          expect(result.ok).toBe(false);
          expect(counter.calls).toBe(1);
        },
      ),
      { numRuns: 100 },
    );
  });
});
