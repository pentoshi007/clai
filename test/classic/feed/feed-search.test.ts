import { describe, expect, it, vi } from "vitest";
import { FocusController } from "../../../src/ui-core/controllers/focus-controller.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import {
  feedHighlight,
  feedRowKey,
  findFeedMatches,
  nearestFeedMatch,
  offsetForFeedMatch,
  paintFeedRow,
} from "../../../src/classic/feed/feed-search.js";
import { TranscriptFind, type TranscriptFindPort } from "../../../src/classic/feed/transcript-find.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";

const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
const MATCH_OPEN = ink.style("\u0000", { bg: "searchMatch", fg: "searchMatchText" }).split("\u0000")[0]!;
const ACTIVE_OPEN = ink.style("\u0000", { bg: "searchActive", fg: "searchActiveText", bold: true }).split("\u0000")[0]!;

function block(itemId: string, lines: readonly string[], sequence = 0): FeedBlock {
  return { key: `0:${itemId}`, itemId, kind: "assistant", open: false, lines, turnId: undefined, sequence };
}

const blocks: readonly FeedBlock[] = [
  block("intro", ["needle in the intro card"]),
  block("a", ["alpha \u001b[1mNeedle\u001b[22m", "nothing here"]),
  block("b", ["two needle and needle", "needle   wrapped\u00a0phrase"]),
  ...Array.from({ length: 30 }, (_, index) => block(`filler-${index}`, [`filler ${index}`, "more"])),
  block("z", ["the last needle"]),
];

describe("feed search", () => {
  it("finds case-insensitive matches in rendered rows and skips the intro", () => {
    const matches = findFeedMatches(blocks, "needle");
    expect(matches.map((match) => [match.itemId, match.occurrence, match.lineIndex, match.start])).toEqual([
      ["a", 0, 0, 6],
      ["b", 0, 0, 4],
      ["b", 1, 0, 15],
      ["b", 2, 1, 0],
      ["z", 0, 0, 9],
    ]);
    expect(findFeedMatches(blocks, "needle")).toBe(matches);
    expect(findFeedMatches(blocks, "   ")).toEqual([]);
  });

  it("matches phrases across any whitespace and escapes regular expression syntax", () => {
    expect(findFeedMatches(blocks, "needle wrapped phrase")).toHaveLength(1);
    expect(findFeedMatches([block("r", ["a.b a*b (x)"])], "a*b")).toHaveLength(1);
    expect(findFeedMatches([block("r", ["a.b a*b (x)"])], "(x)")).toHaveLength(1);
    expect(findFeedMatches([block("r", ["aXb"])], "a.b")).toHaveLength(0);
  });

  it("chooses the nearest match at or before a position", () => {
    const matches = findFeedMatches(blocks, "needle");
    expect(nearestFeedMatch(matches, { blockIndex: blocks.length, lineIndex: 0, start: 0 })).toBe(4);
    expect(nearestFeedMatch(matches, { blockIndex: 2, lineIndex: 0, start: 10 })).toBe(1);
    expect(nearestFeedMatch(matches, { blockIndex: 2, lineIndex: 1, start: 0 })).toBe(3);
    expect(nearestFeedMatch(matches, { blockIndex: 0, lineIndex: 0, start: 0 })).toBe(0);
    expect(nearestFeedMatch([], { blockIndex: 0, lineIndex: 0, start: 0 })).toBe(-1);
  });

  it("centres the viewport on a match row", () => {
    const budget = 9;
    const centred = [
      ...Array.from({ length: 20 }, (_, index) => block(`top-${index}`, [`top ${index}`])),
      block("m", ["the middle needle"]),
      ...Array.from({ length: 20 }, (_, index) => block(`bottom-${index}`, [`bottom ${index}`])),
    ];
    const match = findFeedMatches(centred, "needle")[0]!;
    const offset = offsetForFeedMatch(centred, budget, match)!;
    const window = planTranscriptWindow(centred, budget, offset);
    const row = window.rows.findIndex((entry) => entry.key === feedRowKey(match.blockKey, match.lineIndex));
    expect(row).toBe(Math.floor(budget / 2));
  });

  it("paints matches and the active match without losing the row style", () => {
    const matches = findFeedMatches(blocks, "needle");
    const highlight = feedHighlight(matches, 2);
    const line = `${ink.fg("response", "two needle and needle")}`;
    const painted = paintFeedRow(ink, line, feedRowKey("0:b", 0), highlight);
    expect(stripAnsi(painted)).toBe("two needle and needle");
    expect(painted).toContain(`${MATCH_OPEN}needle`);
    expect(painted).toContain(`${ACTIVE_OPEN}needle`);
    const responseOpen = ink.fg("response", "\u0000").split("\u0000")[0]!;
    const afterMatch = painted.slice(painted.indexOf(`${MATCH_OPEN}needle`) + MATCH_OPEN.length + 6);
    expect(afterMatch).toContain(`${responseOpen} and `);
    expect(paintFeedRow(ink, "untouched", feedRowKey("0:filler-1", 0), highlight)).toBe("untouched");
  });
});

function harness(): { find: TranscriptFind; focus: FocusController; port: TranscriptFindPort & { revealed: string[]; notices: string[] } } {
  const focus = new FocusController();
  const revealed: string[] = [];
  const notices: string[] = [];
  const port = {
    focus,
    revealed,
    notices,
    blocks: () => blocks,
    anchor: () => ({ blockIndex: blocks.length - 1, lineIndex: 0, start: Number.MAX_SAFE_INTEGER }),
    reveal: (match: { itemId: string; occurrence: number }) => { revealed.push(`${match.itemId}#${match.occurrence}`); },
    notify: (text: string) => { notices.push(text); },
  };
  return { find: new TranscriptFind(port), focus, port };
}

describe("transcript find controller", () => {
  it("searches backwards from the view, refines in place and wraps with notices", () => {
    const { find, focus, port } = harness();
    find.open();
    expect(focus.activeContext()).toBe("transcript-search");
    for (const char of "needle") find.handleKey(char, char);
    expect(port.revealed.at(-1)).toBe("z#0");
    find.handleKey("up");
    expect(port.revealed.at(-1)).toBe("b#2");
    find.handleKey("ctrl+r");
    expect(port.revealed.at(-1)).toBe("b#1");
    find.handleKey(" ", " ");
    find.handleKey("a", "a");
    expect(port.revealed.at(-1)).toBe("b#0");
    expect(find.matches()).toHaveLength(1);
    find.handleKey("backspace");
    find.handleKey("backspace");
    expect(find.activeIndex()).toBe(1);
    expect(port.notices).toEqual([]);
    for (let step = 0; step < 4; step += 1) find.handleKey("down");
    expect(port.revealed.at(-1)).toBe("a#0");
    expect(port.notices).toContain("Search wrapped to the first match");
  });

  it("accepts into browse mode where n and N step only while the transcript is focused", () => {
    const { find, focus, port } = harness();
    find.open();
    for (const char of "needle") find.handleKey(char, char);
    expect(find.handleKey("enter")).toBe(true);
    expect(find.getSnapshot()).toMatchObject({ open: true, editing: false });
    expect(focus.activeContext()).toBe("transcript");
    expect(find.handleKey("n")).toBe(true);
    expect(port.revealed.at(-1)).toBe("a#0");
    expect(find.handleKey("shift+n")).toBe(true);
    expect(port.revealed.at(-1)).toBe("z#0");
    focus.focusRegion("composer");
    expect(find.handleKey("n")).toBe(false);
    focus.focusRegion("transcript");
    expect(find.handleKey("x", "x")).toBe(false);
    expect(find.handleKey("escape")).toBe(true);
    expect(find.getSnapshot().open).toBe(false);
  });

  it("closes from the editor with escape and reports missing matches", () => {
    const { find, focus, port } = harness();
    find.open();
    find.handleKey("q", "q");
    find.handleKey("enter");
    expect(port.notices).toContain("No matches");
    expect(find.getSnapshot().editing).toBe(true);
    expect(find.handleKey("ctrl+c")).toBe(false);
    expect(find.handleKey("escape")).toBe(true);
    expect(find.getSnapshot().open).toBe(false);
    expect(focus.activeContext()).toBe("composer");
  });

  it("yields to blocking overlays and resumes editing on Ctrl+R", () => {
    const { find, focus } = harness();
    const listener = vi.fn();
    find.subscribe(listener);
    find.open();
    find.paste("needle\nlatest");
    expect(find.getSnapshot().query).toBe("needle latest");
    const release = focus.pushOverlay("modal");
    expect(find.getSnapshot()).toMatchObject({ open: true, editing: false, query: "needle latest" });
    expect(find.capturesInput()).toBe(false);
    release();
    find.open();
    expect(find.getSnapshot().editing).toBe(true);
    expect(listener).toHaveBeenCalled();
    find.dispose();
    expect(focus.activeContext()).toBe("composer");
  });
});
