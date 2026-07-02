// Feature: web-search DuckDuckGo -> keyed-provider fallback.
//
// DuckDuckGo is the keyless default and frequently returns anti-bot
// challenges (HTTP 202) or upstream 502/5xx responses on shared or
// rate-limited networks. When DDG is the active provider and its
// single attempt fails, `web.search` transparently falls back to a
// keyed provider — Tavily first, then Brave — whenever a key is
// configured for it.
//
// These tests drive the *real* registered provider adapters through
// their HTTPS transport seams (no network I/O) and the `resolveKey`
// option (no keychain I/O), so the whole primary→fallback wiring in
// `webSearch` is exercised, not a mock of it.

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { webSearch } from "../../src/tools/web/search.js";
import { __setDuckduckgoHttpsRequestForTesting } from "../../src/tools/web/providers/duckduckgo.js";
import { __setTavilyHttpsRequestForTesting } from "../../src/tools/web/providers/tavily.js";
import { __setBraveHttpsRequestForTesting } from "../../src/tools/web/providers/brave.js";

// ---------------------------------------------------------------------------
// Transport stubs
// ---------------------------------------------------------------------------

type HttpsRequestFn = typeof import("node:https").request;

/**
 * DuckDuckGo transport: the adapter calls `httpsRequestFn(url, options, cb)`
 * (URL string in the first slot). Emits one synthetic response with the
 * configured status/body and counts invocations.
 */
function makeDdgTransport(
  status: number,
  body: string,
): { fn: HttpsRequestFn; state: { calls: number } } {
  const state = { calls: 0 };
  const fn = ((
    _url: unknown,
    optionsOrCb?: unknown,
    maybeCb?: unknown,
  ): ClientRequest => {
    state.calls += 1;
    const cb =
      typeof maybeCb === "function"
        ? (maybeCb as (res: IncomingMessage) => void)
        : typeof optionsOrCb === "function"
          ? (optionsOrCb as (res: IncomingMessage) => void)
          : undefined;
    const req = new EventEmitter() as unknown as ClientRequest;
    (req as unknown as { end: () => void }).end = () => {};
    setImmediate(() => {
      if (!cb) return;
      const res = new EventEmitter() as unknown as IncomingMessage;
      (res as unknown as { statusCode: number }).statusCode = status;
      cb(res);
      setImmediate(() => {
        (res as unknown as EventEmitter).emit("data", Buffer.from(body, "utf-8"));
        (res as unknown as EventEmitter).emit("end");
      });
    });
    return req;
  }) as HttpsRequestFn;
  return { fn, state };
}

/**
 * Tavily/Brave transport: those adapters call `httpsRequestFn(options, cb)`
 * (options object first) and may `req.write()` a body before `req.end()`.
 * Emits one synthetic response with the configured status/body.
 */
function makeOptionsTransport(
  status: number,
  body: string,
): { fn: HttpsRequestFn; state: { calls: number } } {
  const state = { calls: 0 };
  const fn = ((
    _options: unknown,
    cb?: unknown,
  ): ClientRequest => {
    state.calls += 1;
    const callback = cb as (res: IncomingMessage) => void;
    const req = new EventEmitter() as unknown as ClientRequest & {
      write: (chunk: Buffer | string) => boolean;
      end: () => void;
    };
    req.write = () => true;
    req.end = () => {
      queueMicrotask(() => {
        const res = new EventEmitter() as unknown as IncomingMessage & {
          statusCode: number;
          destroy: () => void;
        };
        res.statusCode = status;
        res.destroy = () => {};
        callback(res);
        queueMicrotask(() => {
          (res as unknown as EventEmitter).emit("data", Buffer.from(body, "utf8"));
          (res as unknown as EventEmitter).emit("end");
        });
      });
    };
    return req;
  }) as HttpsRequestFn;
  return { fn, state };
}

const TAVILY_OK = JSON.stringify({
  results: [
    {
      title: "Tavily Result",
      url: "https://tavily.example/one",
      content: "snippet from tavily",
    },
  ],
});

const BRAVE_OK = JSON.stringify({
  web: {
    results: [
      {
        title: "Brave Result",
        url: "https://brave.example/one",
        description: "snippet from brave",
      },
    ],
  },
});

afterEach(() => {
  __setDuckduckgoHttpsRequestForTesting(undefined);
  __setTavilyHttpsRequestForTesting(undefined);
  __setBraveHttpsRequestForTesting(undefined);
});

describe("web.search DuckDuckGo -> keyed-provider fallback", () => {
  it("falls back to Tavily when DuckDuckGo returns a 502 anti-bot response", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(502, "blocked").fn);
    const tavily = makeOptionsTransport(200, TAVILY_OK);
    __setTavilyHttpsRequestForTesting(tavily.fn);

    const result = await webSearch(
      { query: "latest node.js release" },
      {
        provider: "duckduckgo",
        resolveKey: async (id) =>
          id === "tavily" ? "tvly-fake-key" : undefined,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("tavily:");
    expect(result.output).toContain("https://tavily.example/one");
    expect(tavily.state.calls).toBe(1);
  });

  it("falls back to Tavily when DuckDuckGo returns a 202 anti-bot challenge", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(202, "challenge").fn);
    __setTavilyHttpsRequestForTesting(makeOptionsTransport(200, TAVILY_OK).fn);

    const result = await webSearch(
      { query: "who won the match yesterday" },
      {
        provider: "duckduckgo",
        resolveKey: async (id) =>
          id === "tavily" ? "tvly-fake-key" : undefined,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://tavily.example/one");
  });

  it("prefers Tavily over Brave when both keys are configured", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(502, "blocked").fn);
    const tavily = makeOptionsTransport(200, TAVILY_OK);
    const brave = makeOptionsTransport(200, BRAVE_OK);
    __setTavilyHttpsRequestForTesting(tavily.fn);
    __setBraveHttpsRequestForTesting(brave.fn);

    const result = await webSearch(
      { query: "current bitcoin price" },
      {
        provider: "duckduckgo",
        resolveKey: async () => "fake-key",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://tavily.example/one");
    // Tavily satisfied the request, so Brave must not be contacted.
    expect(tavily.state.calls).toBe(1);
    expect(brave.state.calls).toBe(0);
  });

  it("falls back to Brave when Tavily has no key but Brave does", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(502, "blocked").fn);
    const tavily = makeOptionsTransport(200, TAVILY_OK);
    const brave = makeOptionsTransport(200, BRAVE_OK);
    __setTavilyHttpsRequestForTesting(tavily.fn);
    __setBraveHttpsRequestForTesting(brave.fn);

    const result = await webSearch(
      { query: "weather in tokyo" },
      {
        provider: "duckduckgo",
        resolveKey: async (id) =>
          id === "brave" ? "brave-fake-key" : undefined,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://brave.example/one");
    // Tavily had no key, so its transport must never be invoked.
    expect(tavily.state.calls).toBe(0);
    expect(brave.state.calls).toBe(1);
  });

  it("returns the DuckDuckGo error when it fails and no keyed provider is configured", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(502, "blocked").fn);

    const result = await webSearch(
      { query: "anything" },
      {
        provider: "duckduckgo",
        resolveKey: async () => undefined,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain('"provider": "duckduckgo"');
    // The DDG failure message steers the user to configure a keyed
    // fallback provider.
    expect(result.output).toContain("clai search-provider tavily");
  });

  it("does not fall back when DuckDuckGo succeeds", async () => {
    const ddgHtml = `
<html><body>
<div class="result">
  <h2 class="result__title">
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fddg.example%2Fok">DDG OK</a>
  </h2>
  <a class="result__snippet" href="#">ddg snippet</a>
</div>
</body></html>`;
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(200, ddgHtml).fn);
    const tavily = makeOptionsTransport(200, TAVILY_OK);
    __setTavilyHttpsRequestForTesting(tavily.fn);

    const result = await webSearch(
      { query: "something" },
      {
        provider: "duckduckgo",
        resolveKey: async () => "tvly-fake-key",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://ddg.example/ok");
    // DDG succeeded, so the fallback transport must not be touched.
    expect(tavily.state.calls).toBe(0);
  });

  it("annotates the DuckDuckGo error when a configured fallback also fails", async () => {
    __setDuckduckgoHttpsRequestForTesting(makeDdgTransport(502, "blocked").fn);
    // Tavily configured but also failing (rate-limited).
    __setTavilyHttpsRequestForTesting(makeOptionsTransport(429, "slow down").fn);

    const result = await webSearch(
      { query: "anything" },
      {
        provider: "duckduckgo",
        resolveKey: async (id) =>
          id === "tavily" ? "tvly-fake-key" : undefined,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Fallback also failed");
    expect(result.output).toContain("Tavily");
  });
});
