import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { allocateChrome } from "../../../src/classic/chrome/row-budget.js";
import { blockContextFor, buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { decideCommit } from "../../../src/classic/feed/commit-ledger.js";
import { planLiveTail } from "../../../src/classic/feed/live-tail-policy.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import { hasOpenStyle } from "../../../src/classic/render/ansi-text.js";
import { feedView, GOLDEN_COLOR_MODES, GOLDEN_WIDTHS, scriptedTurn } from "./fixture.js";

const turn = scriptedTurn();

interface Fixture {
  readonly label: string;
  readonly columns: number;
  readonly rows: readonly string[];
}

function fixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const columns of GOLDEN_WIDTHS) {
    for (const colorMode of GOLDEN_COLOR_MODES) {
      for (const unicode of [true, false]) {
        for (const expand of [false, true]) {
          const state = expand
            ? {
                ...turn.state,
                expandThinkingGlobal: true,
                expandOutputGlobal: true,
                expandFileDiffsGlobal: true,
              }
            : turn.state;
          const view = feedView(turn, { columns, colorMode, unicode, withIntro: true });
          const blocks = buildFeedBlocks(state, view);
          out.push({
            label: `${columns}c ${colorMode} ${unicode ? "unicode" : "ascii"} ${expand ? "expanded" : "collapsed"}`,
            columns,
            rows: blocks.flatMap((block) => block.lines),
          });
        }
      }
    }
  }
  return out;
}

const ALL = fixtures();

// biome-ignore lint: ANSI escape sequences are intentional.
const BARE_ESCAPE = /\x1b(?!\[[0-9;]*[A-Za-z])/;

describe("§12.1 — allocateChrome totals never exceed the terminal rows", () => {
  it("holds for every size crossed with every demand shape", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 20, max: 400 }),
        fc.integer({ min: 1, max: 40 }),
        fc.constantFrom(1 as const, 2 as const, 3 as const),
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 12 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 0, max: 30 }),
        fc.option(fc.integer({ min: 0, max: 60 }), { nil: undefined }),
        (rows, columns, composerTextRows, statusRowsWanted, toastCount, queueCount, responderVisible, planVisible, planRowsWanted, overlayRows) => {
          const layout = allocateChrome({
            rows,
            columns,
            composerTextRows,
            statusRowsWanted,
            toastCount,
            queueCount,
            responderVisible,
            planVisible,
            planRowsWanted,
            overlay: overlayRows === undefined ? undefined : { kind: "picker", rowsWanted: overlayRows },
          });
          expect(layout.total).toBeLessThanOrEqual(rows);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});

describe("§12.2 — lines.length is the block's true row count", () => {
  it("no block line contains an embedded newline", () => {
    for (const fixture of ALL) {
      for (const row of fixture.rows) {
        expect(row.includes("\n"), fixture.label).toBe(false);
        expect(row.includes("\r"), fixture.label).toBe(false);
      }
    }
  });
});

describe("§12.3 — every rendered row fits the terminal width", () => {
  it("holds across widths, colour modes, glyph tables, and expansion states", () => {
    for (const fixture of ALL) {
      const budget = fixture.columns;
      for (const row of fixture.rows) {
        expect(
          displayWidth(row),
          `${fixture.label}: ${JSON.stringify(stripAnsi(row))}`,
        ).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("holds for CJK, emoji, combining marks, and ANSI-bearing tool output", () => {
    const hostile = [
      "日本語のテキストがとても長い行になっている場合の折り返し確認です",
      "🇯🇵👨‍👩‍👧‍👦🙂 emoji run with zero-width joiners",
      "अनुच्छेद संयोजन चिह्न वाला पाठ",
      "\x1b[31mred\x1b[0m \x1b[1;32mbold green\x1b[0m plain",
    ].join("\n");
    for (const columns of GOLDEN_WIDTHS) {
      for (const colorMode of GOLDEN_COLOR_MODES) {
        const view = feedView(turn, { columns, colorMode });
        const state = {
          ...turn.state,
          order: ["hostile"],
          byId: new Map([
            [
              "hostile",
              {
                id: "hostile",
                kind: "user" as const,
                sequence: 1,
                turnId: undefined,
                timestamp: 0,
                text: hostile,
              },
            ],
          ]),
        };
        for (const block of buildFeedBlocks(state as never, view)) {
          for (const row of block.lines) {
            expect(displayWidth(row), `${columns}c ${colorMode}`).toBeLessThanOrEqual(columns);
          }
        }
      }
    }
  });
});

describe("§12.4 — no bare escape and no unterminated SGR", () => {
  it("holds over every golden fixture row", () => {
    for (const fixture of ALL) {
      for (const row of fixture.rows) {
        expect(BARE_ESCAPE.test(row), `${fixture.label}: bare escape`).toBe(false);
        expect(hasOpenStyle(row), `${fixture.label}: unterminated SGR`).toBe(false);
      }
    }
  });
});

describe("§12.5 — the live plan never exceeds its granted rows", () => {
  it("fits exactly within the allocator's liveTail for every terminal size", () => {
    for (const rows of [8, 12, 24, 40, 50, 80]) {
      for (const columns of GOLDEN_WIDTHS) {
        const view = feedView(turn, { columns });
        const blocks = buildFeedBlocks(turn.state, view);
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
        const decision = decideCommit({
          blocks,
          liveBudgetRows: layout.liveTail,
          committedCount: 0,
          turnBoundary: false,
        });
        const plan = planLiveTail(
          blockContextFor(turn.state, view),
          decision.live,
          layout.liveTail,
        );
        expect(plan.height, `${rows}r ${columns}c`).toBeLessThanOrEqual(layout.liveTail);
        expect(layout.total).toBeLessThanOrEqual(rows);
      }
    }
  });
});

describe("§12.6 — resize between any two golden widths leaves no over-wide row", () => {
  it("rebuilds live blocks at the new width", () => {
    for (const from of GOLDEN_WIDTHS) {
      for (const to of GOLDEN_WIDTHS) {
        if (from === to) continue;
        buildFeedBlocks(turn.state, feedView(turn, { columns: from }));
        for (const block of buildFeedBlocks(turn.state, feedView(turn, { columns: to }))) {
          for (const row of block.lines) {
            expect(displayWidth(row), `${from}→${to}`).toBeLessThanOrEqual(to);
          }
        }
      }
    }
  });
});

describe("committed blocks survive a shrink", () => {
  it("keeps the committed prefix stable when the live budget collapses", () => {
    const view = feedView(turn, { columns: 80 });
    const blocks = buildFeedBlocks(turn.state, view);
    const wide = decideCommit({ blocks, liveBudgetRows: 40, committedCount: 0, turnBoundary: false });
    const narrow = decideCommit({
      blocks,
      liveBudgetRows: 2,
      committedCount: wide.committedCount,
      turnBoundary: false,
    });
    expect(narrow.committedCount).toBeGreaterThanOrEqual(wide.committedCount);
    expect(narrow.committed.slice(0, wide.committedCount).map((b) => b.key)).toEqual(
      wide.committed.map((b) => b.key),
    );
  });
});
