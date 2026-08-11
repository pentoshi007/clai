import { createElement } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { allocateChrome } from "../../../src/classic/chrome/row-budget.js";
import { blockContextFor, buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { decideCommit } from "../../../src/classic/feed/commit-ledger.js";
import { FeedStatic } from "../../../src/classic/feed/FeedStatic.js";
import { planLiveTail } from "../../../src/classic/feed/live-tail-policy.js";
import { LiveTail } from "../../../src/classic/feed/LiveTail.js";
import {
  flattenBlocks,
  planTranscriptWindow,
} from "../../../src/classic/feed/transcript-window.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { feedView, scriptedTurn } from "./fixture.js";

const turn = scriptedTurn();

interface Frame {
  readonly rows: readonly string[];
  readonly wantedRows: readonly string[];
  readonly liveRows: number;
  readonly liveBudget: number;
}

function renderWindow(columns: number, rows: number, offset = 0): Frame {
  const view = feedView(turn, { columns, withIntro: true });
  const layout = allocateChrome({
    rows,
    columns,
    composerTextRows: 1,
    statusRowsWanted: 2,
    toastCount: 0,
    queueCount: 0,
    responderVisible: false,
    planVisible: false,
    planRowsWanted: 0,
    overlay: undefined,
  });
  const blocks = buildFeedBlocks(turn.state, view);
  const flat = flattenBlocks(blocks);
  const window = planTranscriptWindow(flat, layout.liveTail, offset);
  const wanted = window.rows.map((row) => stripAnsi(row.line).replace(/\s+$/, ""));

  const { lastFrame, unmount } = render(
    createElement(LiveTail, { window, rows: layout.liveTail }),
  );
  const frame = lastFrame() ?? "";
  unmount();

  return {
    rows: frame === "" ? [] : frame.split("\n"),
    wantedRows: wanted,
    liveRows: window.height,
    liveBudget: layout.liveTail,
  };
}

function renderLegacy(columns: number, rows: number): Frame {
  const view = feedView(turn, { columns, withIntro: true });
  const layout = allocateChrome({
    rows,
    columns,
    composerTextRows: 1,
    statusRowsWanted: 2,
    toastCount: 0,
    queueCount: 0,
    responderVisible: false,
    planVisible: false,
    planRowsWanted: 0,
    overlay: undefined,
  });
  const blocks = buildFeedBlocks(turn.state, view);
  const decision = decideCommit({
    blocks,
    liveBudgetRows: layout.liveTail,
    committedCount: 0,
    turnBoundary: false,
  });
  const plan = planLiveTail(blockContextFor(turn.state, view), decision.live, layout.liveTail);

  const { lastFrame, unmount } = render(
    createElement(
      Box,
      { flexDirection: "column" },
      createElement(FeedStatic, { committed: decision.committed }),
    ),
  );
  const frame = lastFrame() ?? "";
  unmount();

  return {
    rows: frame === "" ? [] : frame.split("\n"),
    wantedRows: decision.committed.flatMap((block) =>
      block.lines.map((line) => stripAnsi(line).replace(/\s+$/, "")),
    ),
    liveRows: plan.height,
    liveBudget: layout.liveTail,
  };
}

describe("scripted turn renders exactly its planned window at 80 and 44 columns", () => {
  for (const columns of [80, 44]) {
    describe(`${columns} columns`, () => {
      const frame = renderWindow(columns, 24);

      it("paints every window row exactly once, in order", () => {
        const printed = frame.rows
          .slice(0, frame.wantedRows.length)
          .map((row) => stripAnsi(row).replace(/\s+$/, ""));
        expect(printed).toEqual(frame.wantedRows);
      });

      it("renders no row beyond the block content the planner selected", () => {
        const printed = frame.rows
          .slice(0, frame.wantedRows.length)
          .map((row) => stripAnsi(row).replace(/\s+$/, ""));
        const counts = new Map<string, number>();
        for (const row of printed) counts.set(row, (counts.get(row) ?? 0) + 1);
        const expected = new Map<string, number>();
        for (const row of frame.wantedRows) expected.set(row, (expected.get(row) ?? 0) + 1);
        for (const [row, times] of expected) {
          expect(counts.get(row) ?? 0, `wrong occurrence count: ${JSON.stringify(row)}`).toBe(
            times,
          );
        }
      });

      it("never overflows the terminal width", () => {
        for (const row of frame.rows) {
          expect(displayWidth(row), JSON.stringify(stripAnsi(row))).toBeLessThanOrEqual(
            columns,
          );
        }
      });

      it("keeps the live region inside its granted rows", () => {
        expect(frame.liveRows).toBeLessThanOrEqual(frame.liveBudget);
      });

      it("emits no bare escape and no unterminated SGR", () => {
        for (const row of frame.rows) {
          expect(row).not.toMatch(/\x1b(?!\[[0-9;]*[A-Za-z])/);
        }
      });
    });
  }
});

describe("the transcript window scrolls as one page", () => {
  it("pins to the bottom by default", () => {
    const blocks = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, withIntro: true }));
    const window = planTranscriptWindow(flattenBlocks(blocks), 10, 0);
    expect(window.offset).toBe(0);
    expect(window.lastItemId).toBe(blocks.at(-1)?.itemId);
    expect(window.rows.at(-1)?.line).toBe(blocks.at(-1)?.lines.at(-1));
  });

  it("shows the intro card when scrolled to the very top", () => {
    const blocks = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, withIntro: true }));
    const flat = flattenBlocks(blocks);
    const window = planTranscriptWindow(flat, 10, Number.MAX_SAFE_INTEGER);
    expect(window.offset).toBe(window.maxOffset);
    expect(window.rows[0]?.block.kind).toBe("intro");
    expect(window.rows[0]?.line).toBe(blocks[0]?.lines[0]);
  });

  it("slides by exact line offsets, not by whole blocks", () => {
    const blocks = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, withIntro: true }));
    const flat = flattenBlocks(blocks);
    for (const offset of [0, 1, 2, 3, 7, 11]) {
      const window = planTranscriptWindow(flat, 8, offset);
      expect(window.height).toBeLessThanOrEqual(8);
      expect(window.scrollBelow).toBe(Math.min(offset, window.maxOffset));
      const end = flat.length - window.offset;
      expect(window.rows.map((row) => row.key)).toEqual(
        flat.slice(Math.max(0, end - 8), end).map((row) => row.key),
      );
    }
  });

  it("clamps an oversized offset and reports both scroll remainders", () => {
    const blocks = buildFeedBlocks(turn.state, feedView(turn, { columns: 80, withIntro: true }));
    const flat = flattenBlocks(blocks);
    const window = planTranscriptWindow(flat, 6, 999);
    expect(window.offset).toBe(window.maxOffset);
    expect(window.scrollAbove + window.height + window.scrollBelow).toBe(flat.length);
  });
});

describe("legacy commit-ledger rendering", () => {
  for (const columns of [80, 44]) {
    it(`writes every committed row exactly once, in order (${columns}c)`, () => {
      const frame = renderLegacy(columns, 24);
      const printed = frame.rows.map((row) => stripAnsi(row).replace(/\s+$/, ""));
      const wantedRows = frame.wantedRows.filter((row) => row !== "");
      let cursor = 0;
      for (const wanted of wantedRows) {
        const at = printed.indexOf(wanted, cursor);
        expect(at, `missing or reordered: ${JSON.stringify(wanted)}`).toBeGreaterThanOrEqual(
          cursor,
        );
        cursor = at + 1;
      }
    });
  }
});

describe("frame stability across terminal heights", () => {
  for (const rows of [8, 12, 24, 50]) {
    it(`rows=${rows} produces a live region no taller than its budget`, () => {
      const frame = renderWindow(80, rows);
      expect(frame.liveRows).toBeLessThanOrEqual(frame.liveBudget);
    });
  }
});
