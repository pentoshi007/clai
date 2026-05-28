// Feature: web-search-and-fetch, Task 9.4: registry smoke test
//
// Asserts the tool registry exposes the new `web.search` and
// `web.fetch` handlers (Requirement 4.1) and that both classify as
// `safe` so `tool.batch` accepts them in its fan-out flow
// (`BATCH_SAFE_TOOLS` membership; Requirement 4.6).

import { describe, expect, it } from "vitest";

import {
  availableToolNames,
  toolRegistry,
} from "../../src/tools/registry.js";
import { classifyToolCall } from "../../src/safety/classifier.js";

describe("registry exposes web.search and web.fetch", () => {
  it("both names are present in availableToolNames()", () => {
    const names = availableToolNames();
    expect(names).toContain("web.search");
    expect(names).toContain("web.fetch");
  });

  it("both names dispatch to a callable handler", () => {
    expect(typeof toolRegistry["web.search"]).toBe("function");
    expect(typeof toolRegistry["web.fetch"]).toBe("function");
  });

  it("classifier marks valid web.search and web.fetch calls as safe", () => {
    const search = classifyToolCall({
      name: "web.search",
      args: { query: "what is webrtc" },
    });
    expect(search.level).toBe("safe");

    const fetch = classifyToolCall({
      name: "web.fetch",
      args: { url: "https://example.com/" },
    });
    expect(fetch.level).toBe("safe");
  });

  it("classifier blocks web.fetch URLs that target loopback or non-http schemes", () => {
    expect(
      classifyToolCall({
        name: "web.fetch",
        args: { url: "https://127.0.0.1/admin" },
      }).level,
    ).toBe("block");

    expect(
      classifyToolCall({
        name: "web.fetch",
        args: { url: "file:///etc/passwd" },
      }).level,
    ).toBe("block");
  });
});
