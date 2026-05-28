// Unit tests for `src/tools/web/providers/tavily.ts`.
//
// Validates: Requirements 3.1, 3.3, 6.1, 6.2, 6.5, 6.6
//
// The Tavily adapter is exercised through a stubbed `https.request`
// transport so no real network I/O happens. The stub records the
// request options and JSON body the adapter emitted, then synthesizes
// a response with a configurable status code and body string. Each
// test then asserts the adapter's `RawProviderResponse` matches the
// design's "Per-provider notes → Tavily" section:
//
//   • status mapping — non-2xx forwarded with empty hits, 2xx parsed.
//     The handler (separate module) maps status codes to error kinds;
//     the adapter only has to surface raw status + parseError.
//   • result mapping — `results[].title/url/content` becomes
//     `hits[].title/url/snippet`.
//   • request body — `api_key`, `query`, `max_results`,
//     `search_depth: "basic"` exactly as specified.
//   • `max_results` clamping — defensive `[1..20]` clamp inside the
//     adapter so a misbehaving caller can never POST a value Tavily
//     would reject (or burn quota with).

import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import {
  __setTavilyHttpsRequestForTesting,
  tavilyProvider,
} from "../../../src/tools/web/providers/tavily.js";
import { searchProviders } from "../../../src/tools/web/providers/provider.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface StubOptions {
  status: number;
  body: string;
}

interface CapturedRequest {
  method: string | undefined;
  host: string | undefined;
  path: string | undefined;
  headers: Record<string, unknown>;
  body: string;
}

/**
 * Build an `https.request` stub that:
 *   1. Captures the method/host/path/headers and the JSON body that
 *      the adapter wrote via `req.write()`.
 *   2. Synthesises a fake `IncomingMessage` that emits a single `data`
 *      chunk of `body` bytes followed by `end`, with the configured
 *      `statusCode`.
 *
 * Returns the stub plus a `captured` ref that tests assert on.
 */
function makeHttpsStub(opts: StubOptions): {
  httpsRequest: (
    options: Record<string, unknown>,
    callback: (res: IncomingMessage) => void,
  ) => ClientRequest;
  captured: CapturedRequest;
} {
  const captured: CapturedRequest = {
    method: undefined,
    host: undefined,
    path: undefined,
    headers: {},
    body: "",
  };

  const httpsRequest = (
    options: Record<string, unknown>,
    callback: (res: IncomingMessage) => void,
  ): ClientRequest => {
    captured.method =
      typeof options.method === "string" ? options.method : undefined;
    captured.host =
      typeof options.host === "string" ? options.host : undefined;
    captured.path =
      typeof options.path === "string" ? options.path : undefined;
    captured.headers = (options.headers as Record<string, unknown>) ?? {};

    const req = new EventEmitter() as unknown as ClientRequest & {
      write: (chunk: Buffer | string) => boolean;
      end: () => void;
    };

    // Capture POST body chunks. The adapter writes one Buffer in a
    // single call followed by `end()`.
    req.write = (chunk: Buffer | string): boolean => {
      captured.body +=
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");
      return true;
    };

    req.end = (): void => {
      // Schedule the synthetic response on the next microtask so the
      // adapter has a chance to attach the body listeners first.
      queueMicrotask(() => {
        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          destroy: () => void;
        };
        res.statusCode = opts.status;
        res.destroy = () => {};
        callback(res);
        queueMicrotask(() => {
          (res as unknown as { emit: (...a: unknown[]) => void }).emit(
            "data",
            Buffer.from(opts.body, "utf8"),
          );
          (res as unknown as { emit: (...a: unknown[]) => void }).emit("end");
        });
      });
    };

    return req;
  };

  return { httpsRequest, captured };
}

afterEach(() => {
  // Reset the injected transport so a stub from one test never leaks
  // into the next.
  __setTavilyHttpsRequestForTesting(undefined);
});

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

describe("tavilyProvider identity (Requirements 3.1, 3.3)", () => {
  it("declares the documented id, env var, and key requirement", () => {
    expect(tavilyProvider.id).toBe("tavily");
    expect(tavilyProvider.needsApiKey).toBe(true);
    expect(tavilyProvider.envVar).toBe("TAVILY_API_KEY");
  });

  it("registers itself in the shared searchProviders registry", () => {
    expect(searchProviders.tavily).toBe(tavilyProvider);
  });
});

// ---------------------------------------------------------------------------
// Request shape (POST + JSON body, max_results clamp)
// ---------------------------------------------------------------------------

describe("tavilyProvider request shape", () => {
  it("POSTs JSON to api.tavily.com/search with api_key, query, max_results, search_depth", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "what is fast-check",
      7,
      { apiKey: "tvly-secret-12345" },
      new AbortController().signal,
    );

    expect(result.status).toBe(200);
    expect(stub.captured.method).toBe("POST");
    expect(stub.captured.host).toBe("api.tavily.com");
    expect(stub.captured.path).toBe("/search");
    expect(stub.captured.headers["content-type"]).toBe("application/json");
    expect(stub.captured.headers["accept"]).toBe("application/json");

    // Body is parseable JSON with the documented fields. We assert on
    // the structure rather than the exact byte sequence so a future
    // change in field order does not break the test.
    const body = JSON.parse(stub.captured.body) as Record<string, unknown>;
    expect(body).toEqual({
      api_key: "tvly-secret-12345",
      query: "what is fast-check",
      max_results: 7,
      search_depth: "basic",
    });

    // Content-Length matches the bytes actually written.
    expect(Number(stub.captured.headers["content-length"])).toBe(
      Buffer.byteLength(stub.captured.body, "utf8"),
    );
  });

  it("clamps max_results above 20 to 20", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    await tavilyProvider.search(
      "q",
      9999,
      { apiKey: "k" },
      new AbortController().signal,
    );

    const body = JSON.parse(stub.captured.body) as { max_results: number };
    expect(body.max_results).toBe(20);
  });

  it("clamps max_results below 1 to 1", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    await tavilyProvider.search(
      "q",
      0,
      { apiKey: "k" },
      new AbortController().signal,
    );

    const body = JSON.parse(stub.captured.body) as { max_results: number };
    expect(body.max_results).toBe(1);
  });

  it("clamps non-finite max_results (NaN) to the minimum", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({ results: [] }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    await tavilyProvider.search(
      "q",
      Number.NaN,
      { apiKey: "k" },
      new AbortController().signal,
    );

    const body = JSON.parse(stub.captured.body) as { max_results: number };
    expect(body.max_results).toBe(1);
  });

  it("returns a 0-status response with parseError when no api key is provided (defensive)", async () => {
    // Adapter must NOT dispatch a request without a key. We assert
    // that by leaving the transport stub *unset* and confirming the
    // returned status is 0 (not whatever stub would produce).
    const result = await tavilyProvider.search(
      "q",
      5,
      {},
      new AbortController().signal,
    );

    expect(result.status).toBe(0);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toMatch(/missing api key/i);
  });
});

// ---------------------------------------------------------------------------
// Result mapping (results[].title/url/content → SearchResult)
// ---------------------------------------------------------------------------

describe("tavilyProvider result mapping", () => {
  it("maps results[].title/url/content to hits[].title/url/snippet", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({
        results: [
          {
            title: "Tavily Docs",
            url: "https://docs.tavily.com/",
            content: "Documentation for the Tavily API.",
          },
          {
            title: "Tavily Pricing",
            url: "https://tavily.com/pricing",
            content: "Plans start at free tier.",
          },
        ],
      }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "tavily",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.status).toBe(200);
    expect(result.parseError).toBeUndefined();
    expect(result.hits).toEqual([
      {
        title: "Tavily Docs",
        url: "https://docs.tavily.com/",
        snippet: "Documentation for the Tavily API.",
      },
      {
        title: "Tavily Pricing",
        url: "https://tavily.com/pricing",
        snippet: "Plans start at free tier.",
      },
    ]);
  });

  it("forwards entries that lack one or more fields (handler does final filtering)", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({
        results: [
          { title: "Only title" },
          { url: "https://example.com/" },
          { content: "only snippet" },
          // Non-string fields are dropped per-field; the entry itself
          // still contributes a (possibly empty) hit so the handler
          // can apply Requirement 7.3 filtering.
          { title: 42, url: false, content: null },
          // Non-object entries are skipped entirely.
          null,
          "not an object",
        ],
      }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "q",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.parseError).toBeUndefined();
    expect(result.hits).toEqual([
      { title: "Only title" },
      { url: "https://example.com/" },
      { snippet: "only snippet" },
      {},
    ]);
  });
});

// ---------------------------------------------------------------------------
// Status mapping (mirrors Brave: 401/403 auth, 429 rate-limit, 5xx server,
// non-JSON parse, other non-2xx http)
// ---------------------------------------------------------------------------

describe("tavilyProvider status mapping (Requirements 6.1, 6.2, 6.5, 6.6)", () => {
  it.each([401, 403])(
    "forwards %i with an empty hit list (handler maps to auth)",
    async (status) => {
      const stub = makeHttpsStub({ status, body: "{}" });
      __setTavilyHttpsRequestForTesting(
        stub.httpsRequest as unknown as typeof import("node:https").request,
      );

      const result = await tavilyProvider.search(
        "q",
        5,
        { apiKey: "k" },
        new AbortController().signal,
      );

      expect(result.status).toBe(status);
      expect(result.hits).toEqual([]);
      expect(result.parseError).toBeUndefined();
    },
  );

  it("forwards 429 with an empty hit list (handler maps to rate-limit)", async () => {
    const stub = makeHttpsStub({ status: 429, body: "{}" });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "q",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.status).toBe(429);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toBeUndefined();
  });

  it.each([500, 502, 503, 504])(
    "forwards %i with an empty hit list (handler maps to server)",
    async (status) => {
      const stub = makeHttpsStub({ status, body: "" });
      __setTavilyHttpsRequestForTesting(
        stub.httpsRequest as unknown as typeof import("node:https").request,
      );

      const result = await tavilyProvider.search(
        "q",
        5,
        { apiKey: "k" },
        new AbortController().signal,
      );

      expect(result.status).toBe(status);
      expect(result.hits).toEqual([]);
      expect(result.parseError).toBeUndefined();
    },
  );

  it("forwards an arbitrary non-2xx status (e.g. 418) with an empty hit list (handler maps to http)", async () => {
    const stub = makeHttpsStub({ status: 418, body: "" });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "q",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.status).toBe(418);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toBeUndefined();
  });

  it("flags a 2xx with non-JSON body as parseError (handler maps to parse)", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: "<html>not json</html>",
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "q",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.status).toBe(200);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toMatch(/non-JSON/i);
  });

  it("flags a 2xx with valid JSON but missing results array as parseError", async () => {
    const stub = makeHttpsStub({
      status: 200,
      body: JSON.stringify({ answer: "no array here" }),
    });
    __setTavilyHttpsRequestForTesting(
      stub.httpsRequest as unknown as typeof import("node:https").request,
    );

    const result = await tavilyProvider.search(
      "q",
      5,
      { apiKey: "k" },
      new AbortController().signal,
    );

    expect(result.status).toBe(200);
    expect(result.hits).toEqual([]);
    expect(result.parseError).toMatch(/results array/i);
  });
});
