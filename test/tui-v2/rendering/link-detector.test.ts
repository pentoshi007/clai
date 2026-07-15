import { describe, expect, it } from "vitest";
import { detectLinks } from "../../../src/tui-v2/rendering/link-detector.js";

describe("detectLinks", () => {
  it("detects a bare URL and trims trailing sentence punctuation", () => {
    const spans = detectLinks("See https://example.com/docs?a=1, it helps.");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "url", value: "https://example.com/docs?a=1" });
  });

  it("detects an absolute file path with a line:col suffix", () => {
    const spans = detectLinks("error at /src/app/index.ts:42:7 during build");
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ kind: "path", value: "/src/app/index.ts:42:7" });
  });

  it("detects a relative path and a home-relative path", () => {
    const spans = detectLinks("edited ./src/foo.ts and ~/notes/todo.md");
    expect(spans.map((s) => s.value)).toEqual(["./src/foo.ts", "~/notes/todo.md"]);
  });

  it("does not double-count a path inside a URL", () => {
    const spans = detectLinks("open https://example.com/a/b.png now");
    expect(spans).toHaveLength(1);
    expect(spans[0]?.kind).toBe("url");
  });

  it("returns matches in left-to-right order with correct offsets", () => {
    const text = "first /a/b.ts then https://x.io/y then ./c.ts";
    const spans = detectLinks(text);
    expect(spans.map((s) => s.value)).toEqual(["/a/b.ts", "https://x.io/y", "./c.ts"]);
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.value);
    }
  });

  it("returns no spans for plain text", () => {
    expect(detectLinks("just talking, nothing special here")).toEqual([]);
  });
});
