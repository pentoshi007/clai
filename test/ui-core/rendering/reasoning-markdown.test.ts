import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../../../src/ui-core/rendering/render-markdown-lines.js";
import { EMPTY_MARKDOWN_STREAM_CACHE, renderStreamingMarkdown } from "../../../src/ui-core/rendering/streaming-markdown.js";

const OPTIONS = { width: 120, stripOuterIndent: true, colorMode: "none", isolateBold: true } as const;

function rows(text: string): string[] {
  return renderMarkdownLines(text, OPTIONS);
}

describe("reasoning-only bold line isolation", () => {
  it.each([
    ["before **Title** after", ["before", "Title", "after"]],
    ["**First** body**Second**next", ["First", "body", "Second", "next"]],
    ["before __Title__ after", ["before", "Title", "after"]],
    ["before ***Title*** after", ["before", "Title", "after"]],
    ["**First****Second**", ["First", "Second"]],
    ["**Title**\nbody\n**Next**\nmore", ["Title", "body", "Next", "more"]],
    ["before **日本語 🧪** after", ["before", "日本語 🧪", "after"]],
    ["plain *italic* text", ["plain italic text"]],
    ["plain **unfinished", ["plain **unfinished"]],
    ["before **Title `code`** after", ["before", "Title code", "after"]],
  ] as const)("separates titles without dropping text in %s", (source, expected) => {
    expect(rows(source)).toEqual(expected);
  });

  it.each([
    "Use `**literal**` in code",
    "Use ``**literal**`` in code",
    "Keep \\**escaped\\** together",
    "Keep [**label**](https://example.invalid/**path**) intact",
    "```text\nbefore **literal** after\n```",
    "~~~~text\nbefore **literal** after\n~~~~",
    "```text\nbefore **literal** after",
    "| **Column** | Value |\n| --- | --- |\n| **cell** | body |",
    "# **Existing heading** with text",
    "---",
  ])("preserves literal or structured Markdown in %s", (source) => {
    expect(rows(source)).toEqual(renderMarkdownLines(source, { ...OPTIONS, isolateBold: false }));
  });

  it.each([
    ["- **Title** body", ["• Title", "  body"]],
    ["1. **Title** body", ["1. Title", "   body"]],
    ["- [x] **Title** body", ["☑ Title", "  body"]],
    ["> before **Title** after", ["│ before", "│ Title", "│ after"]],
  ] as const)("retains block prefixes and continuation indentation in %s", (source, expected) => {
    expect(rows(source)).toEqual(expected);
  });

  it("does not change normal assistant emphasis", () => {
    expect(renderMarkdownLines("before **Title** after", { ...OPTIONS, isolateBold: false })).toEqual(["before Title after"]);
  });

  it("wraps long bold titles without mixing in the surrounding prose", () => {
    const title = "heading ".repeat(20).trim();
    const rendered = renderMarkdownLines(`before **${title}** after`, { ...OPTIONS, width: 40 });
    expect(rendered[0]).toBe("before");
    expect(rendered.at(-1)).toBe("after");
    expect(rendered.slice(1, -1).join(" ")).toBe(title);
    expect(rendered.every((row) => row.length <= 40)).toBe(true);
  });

  it("matches a fresh render at every streamed delimiter boundary", () => {
    const source = `${"stable reasoning ".repeat(50)}\n\nfirst **First title** body **Second title** more`;
    let cache = EMPTY_MARKDOWN_STREAM_CACHE;
    for (let end = source.indexOf("first"); end <= source.length; end += 1) {
      const text = source.slice(0, end);
      const rendered = renderStreamingMarkdown({ text, streaming: true, options: OPTIONS, cache });
      expect(rendered.lines).toEqual(renderMarkdownLines(text, OPTIONS));
      cache = rendered.cache;
    }
    expect(cache.stableSource.length).toBeGreaterThan(512);
  });

  it("invalidates stable rows when switching between reasoning and assistant layout", () => {
    const source = `**Stable title** ${"reasoning ".repeat(100)}\n\nlive`;
    const inline = renderStreamingMarkdown({
      text: source,
      streaming: true,
      options: { ...OPTIONS, isolateBold: false },
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    });
    const isolated = renderStreamingMarkdown({ text: source, streaming: true, options: OPTIONS, cache: inline.cache });
    expect(isolated.cache.stableLines).not.toBe(inline.cache.stableLines);
    expect(isolated.lines).toEqual(rows(source));
    const restored = renderStreamingMarkdown({
      text: source,
      streaming: true,
      options: { ...OPTIONS, isolateBold: false },
      cache: isolated.cache,
    });
    expect(restored.cache.stableLines).not.toBe(isolated.cache.stableLines);
    expect(restored.lines).toEqual(renderMarkdownLines(source, { ...OPTIONS, isolateBold: false }));
  });
});
