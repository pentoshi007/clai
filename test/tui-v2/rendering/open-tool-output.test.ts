import { describe, expect, it } from "vitest";
import {
  formatToolPagerBody,
  toolPagerTitle,
} from "../../../src/tui-v2/rendering/open-tool-output.js";

describe("formatToolPagerBody", () => {
  it("renders web.search payloads as a numbered hit list", () => {
    const raw = [
      "duckduckgo: 2 results",
      JSON.stringify({
        results: [
          {
            title: "Keir Starmer",
            url: "https://example.com/a",
            snippet: "Current PM since 2024.",
          },
          {
            title: "GOV.UK",
            url: "https://www.gov.uk/pm",
            snippet: "Official page.",
          },
        ],
      }),
    ].join("\n");
    const out = formatToolPagerBody(raw);
    expect(out).toContain("duckduckgo: 2 results");
    expect(out).toContain("1. Keir Starmer");
    expect(out).toContain("   https://example.com/a");
    expect(out).toContain("2. GOV.UK");
    expect(out).not.toContain('"results"');
  });

  it("pretty-prints generic JSON objects", () => {
    const raw = '{"ok":true,"count":1}';
    const out = formatToolPagerBody(raw);
    expect(out).toContain('"ok": true');
    expect(out).toContain('"count": 1');
  });

  it("leaves non-JSON text alone", () => {
    const raw = "duckduckgo: 5 results\nhello";
    expect(formatToolPagerBody(raw)).toBe(raw);
  });

  it("leaves invalid JSON alone", () => {
    const raw = "{not json";
    expect(formatToolPagerBody(raw)).toBe(raw);
  });
});

describe("toolPagerTitle", () => {
  it("keeps a short stable title", () => {
    expect(toolPagerTitle("web.search", "who is uk pm")).toBe(
      "web.search · who is uk pm",
    );
  });

  it("clips very long args in the title", () => {
    const long = "x".repeat(80);
    const title = toolPagerTitle("web.search", long);
    expect(title.length).toBeLessThan(70);
    expect(title.startsWith("web.search · ")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });
});
