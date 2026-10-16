import { describe, expect, it } from "vitest";
import type { ColorMode } from "../../../src/app/ports/terminal-port.js";
import { buildToolLines } from "../../../src/classic/blocks/tool-lines.js";
import { buildThinkingLines } from "../../../src/classic/blocks/thinking-lines.js";
import { blockContextFor } from "../../../src/classic/feed/feed-blocks.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { transcriptItems, type ThinkingItem, type ToolItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

const modes: readonly ColorMode[] = ["truecolor", "256", "16", "none"];

function fixture(colorMode: ColorMode, expanded = false) {
  const turn = scriptedTurn();
  const ink = createInkTheme({ themeHint: "dark", colorMode, unicode: true });
  const disclosures: NonNullable<ReturnType<typeof blockContextFor>["disclosures"]> = [];
  const ctx = { ...blockContextFor({ ...turn.state, expandThinkingGlobal: expanded }, { ...feedView(turn, { columns: 120 }), ink }), disclosures };
  return { turn, ctx };
}

describe("classic transcript presentation", () => {
  it.each(modes)("uses the ctx color for tool durations and subdued disclosures in %s", (mode) => {
    const { turn, ctx } = fixture(mode);
    const item = transcriptItems(turn.state).find((entry): entry is ToolItem => entry.kind === "tool" && entry.name === "shell.exec")!;
    for (const status of ["running", "ok", "failed"] as const) {
      const rows = buildToolLines({ ...ctx, now: item.timestamp + 1200 }, { ...item, status, endedAt: item.timestamp + 1200 });
      expect(rows[0]).toContain(ctx.ink.fg("userBorder", "1.2s"));
      expect(rows.at(-1)).toContain(ctx.ink.fg("hint", "+ click to expand"));
      if (mode !== "none") expect(rows.at(-1)).not.toContain(ctx.ink.fg("inputBorder", "+ click to expand"));
    }
  });

  it.each(modes)("keeps reasoning controls on the purple header in %s", (mode) => {
    for (const expanded of [false, true]) {
      for (const streaming of [false, true]) {
        const { turn, ctx } = fixture(mode, expanded);
        const item = transcriptItems(turn.state).find((entry): entry is ThinkingItem => entry.kind === "thinking")!;
        const rows = buildThinkingLines(ctx, { ...item, streaming });
        const label = streaming ? "Thinking" : "Reasoning";
        expect(rows[0]).toContain(ctx.ink.style(`• ${label}`, { fg: "thinking", bold: true }));
        expect(stripAnsi(rows[0]!)).toContain(expanded ? "click to collapse" : "click to expand");
        expect(stripAnsi(rows[0]!)).toContain("Ctrl+T");
        expect(ctx.disclosures).toEqual([expect.objectContaining({ lineIndex: 0 })]);
        expect(rows.slice(1).map(stripAnsi).join("\n")).not.toMatch(/click to|Ctrl\+T/);
        expect(rows.every((row) => displayWidth(row) <= ctx.width)).toBe(true);
        if (!expanded) expect(rows).toHaveLength(1);
        if (expanded) expect(rows.length).toBeGreaterThan(1);
      }
    }
  });
});

describe("classic live reasoning", () => {
  it.each([false, true])("streams every line only when expanded=%s", (expanded) => {
    const { turn, ctx } = fixture("none", expanded);
    const item = transcriptItems(turn.state).find((entry): entry is ThinkingItem => entry.kind === "thinking")!;
    const content = [
      ...Array.from({ length: 30 }, (_, index) => `LIVE_LINE_${index}_${"w".repeat(240)}`),
      `LONG_LINE_${"x".repeat(18 * 1024)}_LIVE_END`,
    ].join("\n");
    const rows = buildThinkingLines(ctx, { ...item, content, streaming: true });
    if (expanded) {
      expect(rows.slice(1).map((row) => stripAnsi(row).slice(4)).join("")).toBe(content.replace(/\n/g, ""));
    } else {
      expect(rows).toHaveLength(1);
      expect(stripAnsi(rows[0]!)).toContain("click to expand");
      expect(stripAnsi(rows[0]!)).not.toContain("LIVE_LINE_0");
    }
    expect(rows.every((row) => displayWidth(row) <= ctx.width)).toBe(true);
    expect(ctx.disclosures).toEqual([expect.objectContaining({ lineIndex: 0 })]);
    expect(ctx.state.expandThinkingGlobal).toBe(expanded);
  });

  it("keeps the live card informative while collapsed", () => {
    const { turn, ctx } = fixture("none", false);
    const item = transcriptItems(turn.state).find((entry): entry is ThinkingItem => entry.kind === "thinking")!;
    const content = "reasoning text ".repeat(8);
    const rows = buildThinkingLines(ctx, {
      ...item,
      content,
      streaming: true,
      startedAt: ctx.now - 5_000,
      endedAt: undefined,
    });
    expect(rows).toHaveLength(1);
    const text = stripAnsi(rows[0]!);
    expect(text).toContain("Thinking");
    expect(text).toContain("5.0s");
    expect(text).toContain("~30 tokens");
    expect(text).toContain("+ click to expand");
    expect(text).toContain("Ctrl+T");
  });

  it.each([
    { global: false, override: undefined, expanded: false },
    { global: true, override: undefined, expanded: true },
    { global: true, override: false, expanded: false },
    { global: false, override: true, expanded: true },
  ])("honors the selected completion state $expanded with global=$global override=$override", ({ global, override, expanded }) => {
    const { turn, ctx } = fixture("none", global);
    const item = transcriptItems(turn.state).find((entry): entry is ThinkingItem => entry.kind === "thinking")!;
    const state = { ...ctx.state, itemOverrides: new Map(override === undefined ? [] : [[item.id, override]]) };
    const context = { ...ctx, state };
    const content = "LIVE_FIRST\nLIVE_SECOND\nLIVE_THIRD\nLIVE_LAST";
    const live = buildThinkingLines(context, { ...item, content, streaming: true });
    expect(live).toHaveLength(expanded ? 5 : 1);
    if (expanded) expect(live.at(-1)).toContain("LIVE_LAST");
    expect(live[0]).toContain(expanded ? "click to collapse" : "click to expand");
    expect(live[0]).toContain("Ctrl+T");
    expect(ctx.disclosures).toEqual([expect.objectContaining({ lineIndex: 0 })]);
    ctx.disclosures.length = 0;
    const completed = buildThinkingLines(context, { ...item, content, streaming: false });
    expect(completed).toHaveLength(expanded ? 5 : 1);
    expect(completed[0]).toContain(expanded ? "click to collapse" : "click to expand");
    expect(completed[0]).toContain("Ctrl+T");
    expect(ctx.disclosures).toEqual([expect.objectContaining({ lineIndex: 0 })]);
    expect(state.itemOverrides.get(item.id)).toBe(override);
    expect(state.expandThinkingGlobal).toBe(global);
  });
});
