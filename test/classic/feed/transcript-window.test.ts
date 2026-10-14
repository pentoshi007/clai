import { describe, expect, it, vi } from "vitest";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow, totalTranscriptRows } from "../../../src/classic/feed/transcript-window.js";

function block(id: number, lines: readonly string[]): FeedBlock {
  return {
    key: `0:${id}`,
    itemId: String(id),
    kind: "assistant",
    open: false,
    lines,
    turnId: undefined,
    sequence: id,
  };
}

function flattened(blocks: readonly FeedBlock[]): string[] {
  return blocks.flatMap((entry, index) => [
    ...entry.lines.map((_, line) => `${entry.key}:${line}`),
    ...(index < blocks.length - 1 ? [`${entry.key}:gap`] : []),
  ]);
}

describe("indexed transcript windows", () => {
  it("does not rescan offscreen blocks on each scroll", () => {
    const readLines = vi.fn(() => ["first", "second", "third"]);
    const blocks = Array.from({ length: 5_000 }, (_, index) => ({
      ...block(index, []),
      get lines() { return readLines(); },
    }));
    planTranscriptWindow(blocks, 40, 0);
    readLines.mockClear();
    const window = planTranscriptWindow(blocks, 40, 100);
    expect(window.rows).toHaveLength(40);
    expect(readLines.mock.calls.length).toBeLessThan(200);
    readLines.mockClear();
    expect(totalTranscriptRows(blocks)).toBe(19_999);
    expect(readLines).not.toHaveBeenCalled();
  });

  it("matches complete history at every row, including gaps and empty blocks", () => {
    const blocks = [block(0, []), block(1, ["a", "b"]), block(2, []), block(3, ["c"]), block(4, [])];
    const flat = flattened(blocks);
    for (const budget of [0, 1, 2, 3, 8, 20]) {
      for (const requestedOffset of [-4, 0, 0.9, 1, 2, 3, 4, 5, 6, 100]) {
        const window = planTranscriptWindow(blocks, budget, requestedOffset);
        const offset = Math.max(0, Math.min(Math.floor(requestedOffset), Math.max(0, flat.length - budget)));
        const end = flat.length - offset;
        expect(window.rows.map((row) => row.key)).toEqual(flat.slice(Math.max(0, end - budget), end));
        expect(window.totalRows).toBe(flat.length);
        expect(window.scrollAbove + window.height + window.scrollBelow).toBe(flat.length);
        expect(window.visibleItemIds).toEqual(new Set(window.rows.map((row) => row.block.itemId)));
      }
    }
  });

  it("reindexes changed, appended, resized, reordered, and replaced blocks", () => {
    const first = block(0, ["a", "b"]);
    const last = block(1, ["c"]);
    const blocks = [first, last];
    expect(totalTranscriptRows(blocks)).toBe(4);
    const grown = { ...last, lines: ["c", "d", "e"] };
    for (const next of [[first, grown], [first, last, block(2, ["f"])], [last, first], [grown], []]) {
      const flat = flattened(next);
      expect(totalTranscriptRows(next)).toBe(flat.length);
      expect(planTranscriptWindow(next, 20, 0).rows.map((row) => row.key)).toEqual(flat);
    }
    expect(planTranscriptWindow(blocks, 20, 0).rows.map((row) => row.key)).toEqual(flattened(blocks));
  });

  it("handles an empty transcript and a single empty block", () => {
    for (const blocks of [[], [block(0, [])]]) {
      expect(planTranscriptWindow(blocks, 40, 100)).toMatchObject({
        rows: [], totalRows: 0, height: 0, offset: 0, maxOffset: 0,
        firstItemId: undefined, lastItemId: undefined,
      });
    }
  });
});
