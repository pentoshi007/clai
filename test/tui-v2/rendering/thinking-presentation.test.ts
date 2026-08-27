import { describe, expect, it } from "vitest";
import {
  resolveThinkingFooter,
  resolveThinkingHeadingStyle,
  resolveThinkingPresentation,
  resolveThinkingViewport,
  THINKING_BODY_MAX_ROWS,
  thinkingTokenEstimate,
  wrapThinkingBody,
} from "../../../src/tui-v2/components/transcript/thinking-presentation.js";

describe("OpenTUI thinking presentation", () => {
  const content = "x".repeat(40);

  it("uses one borderless summary line after completed thinking collapses", () => {
    expect(
      resolveThinkingPresentation({
        streaming: false,
        expanded: false,
        elapsed: "3.0s",
        content,
      }),
    ).toEqual({
      heading: "✦ Thought for 3.0s · 10 tokens · click or Ctrl+T to view",
      borderTitle: undefined,
      layout: "line",
      showBody: false,
    });
  });

  it("keeps live reasoning visible with one live heading", () => {
    expect(
      resolveThinkingPresentation({
        streaming: true,
        expanded: false,
        elapsed: "3.0s",
        content,
      }),
    ).toEqual({
      heading: "✦ Reasoning · 3.0s · 10 tokens",
      borderTitle: " ✦ Reasoning · 3.0s · 10 tokens ",
      layout: "card",
      showBody: true,
    });
  });

  it("uses a collapsible completed heading without a duplicate hint", () => {
    expect(
      resolveThinkingPresentation({
        streaming: false,
        expanded: true,
        elapsed: "3.0s",
        content,
      }),
    ).toEqual({
      heading: "✦ Thought for 3.0s · 10 tokens",
      borderTitle: " ✦ Thought for 3.0s · 10 tokens ",
      layout: "card",
      showBody: true,
    });
  });

  it("keeps live content visible even when its post-stream preference toggles", () => {
    const collapsedAfterStreaming = resolveThinkingPresentation({
      streaming: true,
      expanded: false,
      content,
    });
    const expandedAfterStreaming = resolveThinkingPresentation({
      streaming: true,
      expanded: true,
      content,
    });
    expect(collapsedAfterStreaming).toEqual(expandedAfterStreaming);
    expect(collapsedAfterStreaming.heading).toBe("✦ Reasoning · 10 tokens");
    expect(collapsedAfterStreaming.borderTitle).toBe(" ✦ Reasoning · 10 tokens ");
    expect(collapsedAfterStreaming.showBody).toBe(true);
  });

  it("estimates each block independently without inventing tokens for empty text", () => {
    expect(thinkingTokenEstimate("")).toBe(0);
    expect(thinkingTokenEstimate("abcd")).toBe(1);
    expect(thinkingTokenEstimate("x".repeat(4_000))).toBe(1_000);
  });
});

describe("thinking heading hover", () => {
  const accent = "#a78bfa";
  const hover = "#ffffff";

  it("keeps the accent colour with no underline when idle", () => {
    expect(resolveThinkingHeadingStyle({ hovered: false, accent, hover })).toEqual({
      fg: accent,
      underline: false,
    });
  });

  it("highlights and underlines on hover to signal it is clickable", () => {
    expect(resolveThinkingHeadingStyle({ hovered: true, accent, hover })).toEqual({
      fg: hover,
      underline: true,
    });
  });
});

describe("thinking body rows", () => {
  it("wraps short reasoning to its own rows", () => {
    expect(wrapThinkingBody("one\ntwo\nthree", 40, false)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("wraps long lines to the available width", () => {
    const rows = wrapThinkingBody("word ".repeat(20).trim(), 20, false);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(20);
  });

  it("returns no rows for blank reasoning", () => {
    expect(wrapThinkingBody("", 40, false)).toEqual([]);
    expect(wrapThinkingBody("   \n  ", 40, false)).toEqual([]);
  });

  it("bounds very long completed reasoning instead of wrapping it all", () => {
    const rows = wrapThinkingBody("x".repeat(60_000), 40, false);
    expect(rows.length).toBeLessThanOrEqual(20_000 / 40 + 2);
    expect(rows.at(-1)).toBe("…");
  });
});

describe("thinking body viewport", () => {
  it("shows every row when the content fits", () => {
    expect(resolveThinkingViewport({ lineCount: 3, offset: 0 })).toEqual({
      rows: 3,
      offset: 0,
      maxOffset: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });

  it("caps the window and reports hidden rows on both sides", () => {
    const lineCount = THINKING_BODY_MAX_ROWS * 3;
    const maxOffset = lineCount - THINKING_BODY_MAX_ROWS;

    const top = resolveThinkingViewport({ lineCount, offset: 0 });
    expect(top.rows).toBe(THINKING_BODY_MAX_ROWS);
    expect(top).toMatchObject({
      offset: 0,
      maxOffset,
      hiddenAbove: 0,
      hiddenBelow: maxOffset,
    });

    const middle = resolveThinkingViewport({ lineCount, offset: 5 });
    expect(middle).toMatchObject({
      offset: 5,
      hiddenAbove: 5,
      hiddenBelow: maxOffset - 5,
    });
  });

  it("clamps offsets past either edge", () => {
    const lineCount = THINKING_BODY_MAX_ROWS * 3;
    const maxOffset = lineCount - THINKING_BODY_MAX_ROWS;
    expect(resolveThinkingViewport({ lineCount, offset: -5 }).offset).toBe(0);
    expect(resolveThinkingViewport({ lineCount, offset: 999 }).offset).toBe(maxOffset);
  });

  it("treats a non-finite offset as follow-the-tail", () => {
    const lineCount = THINKING_BODY_MAX_ROWS * 3;
    const viewport = resolveThinkingViewport({
      lineCount,
      offset: Number.POSITIVE_INFINITY,
    });
    expect(viewport).toMatchObject({
      offset: lineCount - THINKING_BODY_MAX_ROWS,
      hiddenBelow: 0,
    });
  });

  it("keeps one row for an empty body", () => {
    expect(resolveThinkingViewport({ lineCount: 0, offset: 0 })).toEqual({
      rows: 1,
      offset: 0,
      maxOffset: 0,
      hiddenAbove: 0,
      hiddenBelow: 0,
    });
  });
});

describe("thinking card footer", () => {
  it("invites a click when unfocused and scrollable", () => {
    expect(resolveThinkingFooter({ focused: false, hiddenAbove: 0, hiddenBelow: 12 })).toBe(
      " click to focus ",
    );
  });

  it("always invites a click when unfocused, even with nothing hidden", () => {
    expect(resolveThinkingFooter({ focused: false, hiddenAbove: 0, hiddenBelow: 0 })).toBe(
      " click to focus ",
    );
  });

  it("shows hidden-row counters and the copy hint once focused", () => {
    expect(resolveThinkingFooter({ focused: true, hiddenAbove: 4, hiddenBelow: 7 })).toBe(
      " ↑ 4 · ↓ 7 · c to copy ",
    );
  });

  it("offers copy on a focused card that needs no scrolling", () => {
    expect(resolveThinkingFooter({ focused: true, hiddenAbove: 0, hiddenBelow: 0 })).toBe(
      " c to copy ",
    );
  });
});
