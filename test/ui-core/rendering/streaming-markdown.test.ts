import { describe, expect, it } from "vitest";
import {
  EMPTY_MARKDOWN_STREAM_CACHE,
  renderStreamingMarkdown,
  stableMarkdownSplit,
} from "../../../src/ui-core/rendering/streaming-markdown.js";
import { renderMarkdownLines } from "../../../src/ui-core/rendering/render-markdown-lines.js";

const OPTIONS = { width: 72, stripOuterIndent: true } as const;

const SGR = /\x1b\[[0-9;]*m/g;

function plain(lines: ReturnType<typeof renderMarkdownLines>): string[] {
  return lines.map((line) => line.replace(SGR, ""));
}

const PROSE = Array.from(
  { length: 40 },
  (_, index) =>
    `Paragraph ${index} explains the change in enough words to wrap across the configured width budget.`,
).join("\n\n");

describe("streaming markdown rendering (TUI-004)", () => {
  it("finalized rows render exactly like a one-shot render", () => {
    const sources = [
      PROSE,
      "# Title\n\nBody text.\n\n- one\n- two\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
      "intro\n\n```ts\nconst x = 1;\n```\n\ndone",
    ];
    for (const text of sources) {
      const rendered = renderStreamingMarkdown({
        text,
        streaming: false,
        options: OPTIONS,
        cache: EMPTY_MARKDOWN_STREAM_CACHE,
      });
      expect(plain(rendered.lines)).toEqual(plain(renderMarkdownLines(text, OPTIONS)));
      expect(rendered.cache.stableSource).toBe("");
    }
  });

  it("streaming paragraphs match the one-shot render at every frame", () => {
    let cache = EMPTY_MARKDOWN_STREAM_CACHE;
    for (let end = 600; end <= PROSE.length; end += 350) {
      const text = PROSE.slice(0, end);
      const rendered = renderStreamingMarkdown({
        text,
        streaming: true,
        options: OPTIONS,
        cache,
      });
      cache = rendered.cache;
      expect(plain(rendered.lines)).toEqual(plain(renderMarkdownLines(text, OPTIONS)));
    }
    expect(cache.stableSource.length).toBeGreaterThan(0);
  });

  it("keeps the re-rendered tail small while the stable prefix grows", () => {
    const split = stableMarkdownSplit(PROSE);
    expect(split.stable.length).toBeGreaterThan(PROSE.length * 0.8);
    expect(split.tail.length).toBeLessThan(600);
    expect(split.stable + split.tail).toBe(PROSE);
  });

  it("never splits a list, table, quote or open fence away from its block", () => {
    const listTail = `${"paragraph body that is long enough to pass the minimum stable budget. ".repeat(12)}\n\n- item one\n- item two`;
    expect(stableMarkdownSplit(listTail).tail).toContain("- item one");
    expect(stableMarkdownSplit(listTail).stable).not.toContain("- item one");

    const openFence = `${"prose ".repeat(120)}\n\n\`\`\`ts\nconst a = 1;\n\nconst b = 2;`;
    const fenceSplit = stableMarkdownSplit(openFence);
    expect(fenceSplit.stable).not.toContain("```");
    expect(fenceSplit.tail.startsWith("```ts")).toBe(true);
  });

  it("reuses cached stable lines when only the tail changes", () => {
    const first = renderStreamingMarkdown({
      text: PROSE,
      streaming: true,
      options: OPTIONS,
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    });
    const second = renderStreamingMarkdown({
      text: `${PROSE} more words arrive.`,
      streaming: true,
      options: OPTIONS,
      cache: first.cache,
    });
    expect(second.cache.stableSource).toBe(first.cache.stableSource);
    expect(second.cache.stableLines).toBe(first.cache.stableLines);
  });

  it("drops a stale cache when the wrap width changes", () => {
    const first = renderStreamingMarkdown({
      text: PROSE,
      streaming: true,
      options: OPTIONS,
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    });
    const narrow = { ...OPTIONS, width: 40 };
    const second = renderStreamingMarkdown({
      text: PROSE,
      streaming: true,
      options: narrow,
      cache: first.cache,
    });
    expect(second.cache.stableLines).not.toBe(first.cache.stableLines);
    expect(plain(second.lines)).toEqual(plain(renderMarkdownLines(PROSE, narrow)));
  });
});
