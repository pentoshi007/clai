// Unit tests for the Brave Search provider adapter.
//
// Validates Requirements 3.1, 3.3, 6.1, 6.2, 6.5, 6.6 by exercising the
// adapter's:
//   - HTTP status mapping (401/403 → auth, 429 → rate-limit, 5xx → server,
//     non-JSON → parse, other non-2xx → http) — the adapter forwards the
//     raw status; here we assert the raw signals the handler will key off.
//   - Successful result mapping from `web.results[]` to the
//     `RawProviderResponse.hits` shape.
//   - Auth-header injection (`X-Subscription-Token: <key>`).
//   - Endpoint composition (host/path/query parameters).
//
// The HTTPS transport is replaced with a stub via the module-private
// `__setBraveHttpsRequestForTesting` seam so no real network I/O happens.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import {
  braveProvider,
  __setBraveHttpsRequestForTesting,
} from "../../../src/tools/web/providers/brave.js";

// ---------------------------------------------------------------------------
// HTTPS transport stub
// ---------------------------------------------------------------------------

/**
 * Captured details of the most recent outbound request issued by the
 * adapter. The stub records these synchronously so tests can assert
 * endpoint/auth-header behavior.
 */
interface CapturedRequest {
  method?: string;
  host?: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
}

interface StubOptions {
  /** Status code on the synthetic IncomingMessage. */
  status: number;
  /** Bytes emitted as a single `data` chunk. */
  body: string;
  /** Capture sink populated when the stub is invoked. */
  captured: CapturedRequest;
  /**
   * Optional override: if provided, the stub emits an error on the
   * request (simulating DNS/connect/TLS failure) instead of producing
   * a response.
   */
  errorOnRequest?: Error;
}

/**
 * Build an in-process replacement for `https.request` that records the
 * outgoing options into `captured` and emits a synthetic
 * `IncomingMessage` with the configured status and body.
 */
function makeHttpsRequestStub(opts: StubOptions): typeof import("node:https").request {
  const fn = ((arg1: unknown, arg2: unknown, _arg3?: unknown): ClientRequest => {
    // Brave dispatches with the (options, callback) overload, but we
    // tolerate the (url, options, callback) overload too for safety.
    let options: Record<string, unknown>;
    let cb: ((res: IncomingMessage) => void) | undefined;
    if (typeof arg1 === "string" || arg1 instanceof URL) {
      options = (arg2 as Record<string, unknown>) ?? {};
      cb = _arg3 as ((res: IncomingMessage) => void) | undefined;
    } else {
      options = (arg1 as Record<string, unknown>) ?? {};
      cb = arg2 as ((res: IncomingMessage) => void) | undefined;
    }

    opts.captured.method = options["method"] as string | undefined;
    opts.captured.host = options["host"] as string | undefined;
    opts.captured.path = options["path"] as string | undefined;
    opts.captured.headers =
      (options["headers"] as Record<string, string | string[] | undefined>) ??
      {};

    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = (): void => {
      queueMicrotask(() => {
        if (opts.errorOnRequest) {
          (req as unknown as { emit: (...a: unknown[]) => void }).emit(
            "error",
            opts.errorOnRequest,
          );
          return;
        }
        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = opts.status;
        res.headers = { "content-type": "application/json" };
        res.destroy = () => {};
        cb?.(res);
        // Emit body on a later microtask so the adapter has time to
        // attach `data`/`end` listeners after the callback fires.
        queueMicrotask(() => {
          (res as { emit: (...a: unknown[]) => void }).emit(
            "data",
            Buffer.from(opts.body, "utf-8"),
          );
          (res as { emit: (...a: unknown[]) => void }).emit("end");
        });
      });
    };
    return req;
  }) as typeof import("node:https").request;
  return fn;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_API_KEY = "brave-test-key-12345";

/** Minimal but well-formed Brave Web Search response body. */
const VALID_BRAVE_BODY = JSON.stringify({
  web: {
    results: [
      {
        title: "Example Result 1",
        url: "https://example.com/one",
        description: "First snippet describing example one.",
      },
      {
        title: "Example Result 2",
        url: "https://example.org/two",
        description: "Second snippet describing example two.",
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// Reset transport between tests so a stub leaking from one case cannot
// affect another.
// ---------------------------------------------------------------------------

beforeEach(() => {
  __setBraveHttpsRequestForTesting(undefined);
});

afterEach(() => {
  __setBraveHttpsRequestForTesting(undefined);
});

// ---------------------------------------------------------------------------
// Provider metadata
// ---------------------------------------------------------------------------

describe("braveProvider metadata", () => {
  it("declares id, needsApiKey, and envVar matching Requirements 3.1/3.3", () => {
    expect(braveProvider.id).toBe("brave");
    expect(braveProvider.needsApiKey).toBe(true);
    expect(braveProvider.envVar).toBe("BRAVE_SEARCH_API_KEY");
    expect(braveProvider.displayName).toBe("Brave Search");
  });
});

// ---------------------------------------------------------------------------
// Auth header injection + endpoint composition
// ---------------------------------------------------------------------------

describe("braveProvider auth-header injection and endpoint composition", () => {
  it("sends X-Subscription-Token with the resolved key and targets api.search.brave.com", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 200,
        body: VALID_BRAVE_BODY,
        captured,
      }),
    );

    const controller = new AbortController();
    const result = await braveProvider.search(
      "kiro spec workflow",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );

    expect(result.status).toBe(200);
    expect(captured.method).toBe("GET");
    expect(captured.host).toBe("api.search.brave.com");

    // Path encodes the query and `count` parameter exactly as Brave
    // expects. URLSearchParams uses `+` for spaces.
    expect(captured.path).toBe(
      "/res/v1/web/search?q=kiro+spec+workflow&count=5",
    );

    // Auth header injected with the canonical casing.
    expect(captured.headers["X-Subscription-Token"]).toBe(TEST_API_KEY);
    // Accept JSON.
    expect(captured.headers["accept"]).toBe("application/json");
  });

  it("returns a 0-status `parseError` placeholder and skips the network when no key is supplied", async () => {
    let dispatched = false;
    __setBraveHttpsRequestForTesting(
      ((..._args: unknown[]) => {
        dispatched = true;
        return new EventEmitter() as unknown as ClientRequest;
      }) as typeof import("node:https").request,
    );

    const controller = new AbortController();
    const result = await braveProvider.search(
      "any query",
      5,
      {},
      controller.signal,
    );

    expect(dispatched).toBe(false);
    expect(result.status).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Result mapping
// ---------------------------------------------------------------------------

describe("braveProvider result mapping", () => {
  it("maps web.results[].title/.url/.description into RawProviderResponse.hits", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 200,
        body: VALID_BRAVE_BODY,
        captured,
      }),
    );

    const controller = new AbortController();
    const result = await braveProvider.search(
      "test query",
      10,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );

    expect(result.status).toBe(200);
    expect(result.parseError).toBeUndefined();
    expect(result.hits).toEqual([
      {
        title: "Example Result 1",
        url: "https://example.com/one",
        snippet: "First snippet describing example one.",
      },
      {
        title: "Example Result 2",
        url: "https://example.org/two",
        snippet: "Second snippet describing example two.",
      },
    ]);
  });

  it("forwards entries even when individual fields are missing (lets the handler filter)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 200,
        body: JSON.stringify({
          web: {
            results: [
              { title: "Only title" },
              { url: "https://example.com" },
              { description: "Only snippet" },
              { title: "Full", url: "https://full.example", description: "ok" },
              "not an object",
            ],
          },
        }),
        captured,
      }),
    );

    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );

    expect(result.status).toBe(200);
    expect(result.hits).toEqual([
      { title: "Only title" },
      { url: "https://example.com" },
      { snippet: "Only snippet" },
      { title: "Full", url: "https://full.example", snippet: "ok" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Status-code mapping (raw signals; the handler maps these to error kinds)
// ---------------------------------------------------------------------------

describe("braveProvider status-code mapping", () => {
  it("forwards 401 with empty hits so the handler maps to `auth` (Requirement 6.1)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 401,
        body: '{"error":"unauthorized"}',
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(401);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toBeUndefined();
  });

  it("forwards 403 with empty hits so the handler maps to `auth` (Requirement 6.1)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 403,
        body: '{"error":"forbidden"}',
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(403);
    expect(result.hits).toEqual([]);
  });

  it("forwards 429 with empty hits so the handler maps to `rate-limit` (Requirement 6.2)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 429,
        body: '{"error":"too many requests"}',
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(429);
    expect(result.hits).toEqual([]);
  });

  it("forwards 500/502/503 with empty hits so the handler maps to `server` (Requirement 6.6)", async () => {
    for (const status of [500, 502, 503] as const) {
      const captured: CapturedRequest = { headers: {} };
      __setBraveHttpsRequestForTesting(
        makeHttpsRequestStub({
          status,
          body: "internal error",
          captured,
        }),
      );
      const controller = new AbortController();
      const result = await braveProvider.search(
        "q",
        5,
        { apiKey: TEST_API_KEY },
        controller.signal,
      );
      expect(result.status).toBe(status);
      expect(result.hits).toEqual([]);
    }
  });

  it("forwards other non-2xx (e.g. 418) with empty hits so the handler maps to `http` (Requirement 1.9)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 418,
        body: "I am a teapot",
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(418);
    expect(result.hits).toEqual([]);
  });

  it("flags `parseError` when the 2xx body is not valid JSON (Requirement 6.5)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 200,
        body: "<html>not json</html>",
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(200);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toBeDefined();
    expect(result.parseError).toMatch(/non-JSON response/);
  });

  it("flags `parseError` when the 2xx JSON shape is unexpected (Requirement 6.5)", async () => {
    const captured: CapturedRequest = { headers: {} };
    __setBraveHttpsRequestForTesting(
      makeHttpsRequestStub({
        status: 200,
        body: JSON.stringify({ unrelated: "shape" }),
        captured,
      }),
    );
    const controller = new AbortController();
    const result = await braveProvider.search(
      "q",
      5,
      { apiKey: TEST_API_KEY },
      controller.signal,
    );
    expect(result.status).toBe(200);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toMatch(/missing web\.results/);
  });
});
