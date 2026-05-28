// Feature: web-search-and-fetch, Task 7.8: web.search behavior unit tests
//
// Covers:
//   • Requirement 1.7: zero-result outcome returns ok=true with the
//     literal output "No results found.".
//   • Requirement 3.4: a `brave` invocation with no key configured
//     returns error.kind="missing-key" and includes the exact
//     `clai set brave` hint.
//   • Requirement 3.5: a fresh install (no `activeSearchProvider`
//     configured) defaults to DuckDuckGo and runs without a key.

import { describe, expect, it } from "vitest";

import { webSearch } from "../../src/tools/web/search.js";
import type {
  RawProviderResponse,
  SearchProvider,
} from "../../src/tools/web/providers/provider.js";

function makeProvider(
  id: SearchProvider["id"],
  raw: RawProviderResponse,
  needsApiKey = false,
): SearchProvider {
  return {
    id,
    displayName: id === "brave" ? "Brave Search" : id === "tavily" ? "Tavily" : "DuckDuckGo",
    needsApiKey,
    async search(): Promise<RawProviderResponse> {
      return raw;
    },
  };
}

describe("web.search unit tests", () => {
  it("returns the literal 'No results found.' when the provider yields zero hits (Requirement 1.7)", async () => {
    const result = await webSearch(
      { query: "anything goes here" },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider("duckduckgo", {
          status: 200,
          hits: [],
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBe("No results found.");
  });

  it("returns missing-key with the exact `clai set brave` hint when Brave has no key (Requirement 3.4)", async () => {
    const result = await webSearch(
      { query: "what's new in Vite?" },
      {
        provider: "brave",
        providerOverride: makeProvider(
          "brave",
          { status: 200, hits: [{ title: "x", url: "https://example.com/x" }] },
          /*needsApiKey*/ true,
        ),
        // Resolve to undefined so the missing-key branch fires.
        resolveKey: async () => undefined,
      },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("Brave Search requires an API key");
    expect(result.output).toContain("clai set brave");
    // The categorical kind must surface in the JSON envelope so the
    // agent loop can branch on it.
    expect(result.output).toContain('"kind": "missing-key"');
  });

  it("DuckDuckGo invocation succeeds with no key (Requirement 3.5)", async () => {
    const result = await webSearch(
      { query: "round" },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider("duckduckgo", {
          status: 200,
          hits: [
            { title: "ddg one", url: "https://example.com/one", snippet: "x" },
          ],
        }),
        // Even if the resolver were called, return undefined to simulate
        // a fresh install with no stored secrets. DuckDuckGo's
        // `needsApiKey=false` means the resolver should not be touched
        // at all.
        resolveKey: async () => undefined,
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://example.com/one");
  });

  it("filters hits with non-http(s) schemes, whitespace, or control chars (Requirement 7.3)", async () => {
    const result = await webSearch(
      { query: "filter me" },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider("duckduckgo", {
          status: 200,
          hits: [
            { title: "ftp", url: "ftp://example.com/" },
            { title: "ws", url: "https://example.com/ space" },
            { title: "ctrl", url: "https://example.com/\u0000bell" },
            { title: "good", url: "https://example.com/ok", snippet: "ok" },
          ],
        }),
      },
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain("https://example.com/ok");
    expect(result.output).not.toContain("ftp://example.com");
    expect(result.output).not.toContain("space");
    expect(result.output).not.toContain("bell");
  });

  it("surfaces auth errors with the `clai set <provider>` hint (Requirement 6.1)", async () => {
    const result = await webSearch(
      { query: "x" },
      {
        provider: "brave",
        providerOverride: makeProvider(
          "brave",
          { status: 401, hits: [] },
          true,
        ),
        resolveKey: async () => "fake-key",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/HTTP 401/);
    expect(result.output).toContain("clai set brave");
    expect(result.output).toContain('"kind": "auth"');
  });

  it("classifies 429 as rate-limit and 5xx as server (Requirements 6.2, 6.6)", async () => {
    const ratelimited = await webSearch(
      { query: "x" },
      {
        provider: "tavily",
        providerOverride: makeProvider(
          "tavily",
          { status: 429, hits: [] },
          true,
        ),
        resolveKey: async () => "tvly-fake",
      },
    );
    expect(ratelimited.ok).toBe(false);
    expect(ratelimited.output).toContain('"kind": "rate-limit"');

    const servererr = await webSearch(
      { query: "x" },
      {
        provider: "tavily",
        providerOverride: makeProvider(
          "tavily",
          { status: 503, hits: [] },
          true,
        ),
        resolveKey: async () => "tvly-fake",
      },
    );
    expect(servererr.ok).toBe(false);
    expect(servererr.output).toContain('"kind": "server"');
  });

  it("classifies non-JSON / unexpected shape as parse error (Requirement 6.5)", async () => {
    const result = await webSearch(
      { query: "x" },
      {
        provider: "duckduckgo",
        providerOverride: makeProvider("duckduckgo", {
          status: 200,
          hits: [],
          parseError: "non-JSON response",
        }),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('"kind": "parse"');
    expect(result.output).toContain("non-JSON response");
  });
});
