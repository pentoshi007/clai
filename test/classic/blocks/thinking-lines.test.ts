import { describe, expect, it } from "vitest";
import type { ColorMode } from "../../../src/app/ports/terminal-port.js";
import { EMPTY_SPOOL, type BlockContext } from "../../../src/classic/blocks/block-context.js";
import { renderThinkingLines } from "../../../src/classic/blocks/thinking-lines.js";
import { glyphsFor } from "../../../src/classic/render/glyphs.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { EMPTY_TRANSCRIPT_STATE, type ThinkingItem } from "../../../src/ui-core/state/transcript-types.js";

function context(colorMode: ColorMode = "truecolor", width = 80): BlockContext {
  return {
    width,
    ink: createInkTheme({ themeHint: "dark", colorMode, unicode: true }),
    glyphs: glyphsFor(true),
    now: 0,
    state: { ...EMPTY_TRANSCRIPT_STATE, expandThinkingGlobal: true },
    spool: EMPTY_SPOOL,
    markdownCache: undefined,
  };
}

function thinking(content: string, streaming: boolean): ThinkingItem {
  return { id: "thinking-markdown", sequence: 1, timestamp: 0, turnId: undefined, kind: "thinking", content, streaming };
}

function body(lines: readonly string[]): string {
  return lines.slice(1).join("\n");
}

describe.each([false, true])("classic reasoning Markdown while streaming=%s", (streaming) => {
  it("isolates repeated bold reasoning titles from the prose on both sides", () => {
    const source = "opening **First title** first body **Second title** second body";
    const rendered = renderThinkingLines(context(), thinking(source, streaming));
    const rows = rendered.lines.slice(1).map((line) => stripAnsi(line).trim());
    expect(rows).toEqual(["opening", "First title", "first body", "Second title", "second body"]);
  });

  it.each<ColorMode>(["truecolor", "256", "16", "none"])("renders emphasis and code in %s", (mode) => {
    const item = thinking("plain **BOLD** *italic* ~~removed~~ `code` end", streaming);
    const rendered = body(renderThinkingLines(context(mode), item).lines);
    expect(stripAnsi(rendered).split("\n").map((row) => row.trim())).toEqual(["plain", "BOLD", "italic removed code end"]);
    if (mode !== "none") {
      expect(rendered).toContain("\x1b[1mBOLD");
      expect(rendered).toContain("\x1b[3mitalic");
      expect(rendered).toContain("\x1b[9mremoved");
    } else {
      expect(rendered).not.toContain("\x1b");
    }
    expect(item.content).toBe("plain **BOLD** *italic* ~~removed~~ `code` end");
  });

  it.each([40, 68, 120])("wraps formatted Unicode reasoning within %s columns", (width) => {
    const ctx = context("truecolor", width);
    const item = thinking(`**${"日本語 🧪 long thought ".repeat(30)}**`, streaming);
    const { lines } = renderThinkingLines(ctx, item);
    expect(lines.every((line) => displayWidth(line) <= width)).toBe(true);
    expect(body(lines)).not.toContain("**");
    expect(stripAnsi(body(lines))).toContain("日本語");
  });

  it("keeps Markdown delimiters literal inside a fenced code block", () => {
    const rendered = body(renderThinkingLines(context(), thinking("```text\n**literal**\n```", streaming)).lines);
    expect(stripAnsi(rendered)).toContain("**literal**");
    expect(stripAnsi(rendered)).not.toContain("```text");
  });
});

describe("classic reasoning streaming updates", () => {
  it("styles delimiters that arrive across chunks and matches the finished body", () => {
    let ctx = context();
    let source = "";
    let lines: string[] = [];
    for (const chunk of ["plain **BO", "LD** and *ita", "lic* with `co", "de` end"]) {
      source += chunk;
      const rendered = renderThinkingLines(ctx, thinking(source, true));
      lines = rendered.lines;
      ctx = { ...ctx, markdownCache: rendered.cache };
    }
    expect(body(lines)).toContain("\x1b[1mBOLD");
    expect(stripAnsi(body(lines)).split("\n").map((row) => row.trim())).toEqual(["plain", "BOLD", "and italic with code end"]);
    expect(body(lines)).toBe(body(renderThinkingLines(ctx, thinking(source, false)).lines));
  });

  it("reuses completed Markdown paragraphs while the live tail grows", () => {
    const ctx = context();
    const prefix = `**stable** ${"reasoning ".repeat(80)}\n\n`;
    const first = renderThinkingLines(ctx, thinking(`${prefix}**ta`, true));
    const next = renderThinkingLines({ ...ctx, markdownCache: first.cache }, thinking(`${prefix}**tail**`, true));
    expect(first.cache.stableSource).toBe(prefix);
    expect(next.cache.stableLines).toBe(first.cache.stableLines);
    expect(body(next.lines)).toContain("\x1b[1mtail");
  });

  it("rerenders changed content and terminal widths without stale styling", () => {
    const ctx = context();
    const first = renderThinkingLines(ctx, thinking(`**old** ${"text ".repeat(180)}\n\nlive`, true));
    const next = renderThinkingLines({ ...ctx, width: 40, markdownCache: first.cache }, thinking("**new** plain", true));
    expect(stripAnsi(body(next.lines)).split("\n").map((row) => row.trim())).toEqual(["new", "plain"]);
    expect(body(next.lines)).toContain("\x1b[1mnew");
    expect(next.lines.every((line) => displayWidth(line) <= 40)).toBe(true);
  });
});
