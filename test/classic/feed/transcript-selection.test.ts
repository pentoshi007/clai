import { describe, expect, it } from "vitest";
import type { SelectionState } from "../../../src/ui-core/controllers/selection-controller.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import {
  anchorAtTranscriptPointer,
  classicTranscriptDocument,
  selectionSpanForRow,
} from "../../../src/classic/feed/transcript-selection.js";
import {
  flattenBlocks,
  planTranscriptWindow,
} from "../../../src/classic/feed/transcript-window.js";

function block(key: string, itemId: string, lines: readonly string[]): FeedBlock {
  return { key, itemId, kind: "assistant", open: false, lines, turnId: undefined, sequence: 0 };
}

function state(anchor: { blockId: string; offset: number }, focus: { blockId: string; offset: number }): SelectionState {
  return {
    activePane: "transcript",
    range: { pane: "transcript", anchor, focus },
    dragging: false,
    autoscrollPane: undefined,
  };
}

describe("classic transcript selection", () => {
  it("builds stable rendered blocks and strips ANSI styling", () => {
    const blocks = [
      block("0:duplicate", "duplicate", ["\u001b[31mred\u001b[0m  ", "second"]),
      block("1:duplicate", "duplicate", ["blue"]),
    ];
    expect(classicTranscriptDocument(blocks)).toEqual({
      blocks: [
        { id: "0:duplicate", text: "red\nsecond" },
        { id: "1:duplicate", text: "blue" },
      ],
    });
  });

  it("maps terminal geometry, source line indices, and wide columns to anchors", () => {
    const blocks = [block("0:a", "a", ["zero", "A界B"]), block("0:b", "b", ["last"])];
    const flat = flattenBlocks(blocks);
    expect(flat.map((row) => row.lineIndex)).toEqual([0, 1, undefined, 0]);
    const window = planTranscriptWindow(flat, 4, 0);
    expect(anchorAtTranscriptPointer(window, 5, 3, { left: 2, top: 2 })).toEqual({
      blockId: "0:a",
      offset: 7,
    });
    expect(anchorAtTranscriptPointer(window, 1, 1, { left: 2, top: 2 })).toBeUndefined();
    expect(anchorAtTranscriptPointer(window, 1, 1, { left: 2, top: 2 }, true)).toEqual({
      blockId: "0:a",
      offset: 0,
    });
  });

  it("orders reversed ranges and returns visible row spans", () => {
    const blocks = [block("0:a", "a", ["alpha", "bravo"]), block("0:b", "b", ["charlie"])];
    const document = classicTranscriptDocument(blocks);
    const rows = flattenBlocks(blocks);
    const selection = state(
      { blockId: "0:b", offset: 3 },
      { blockId: "0:a", offset: 2 },
    );
    expect(selectionSpanForRow(rows[0]!, document, selection)).toEqual({ text: "alpha", start: 2, end: 5 });
    expect(selectionSpanForRow(rows[1]!, document, selection)).toEqual({ text: "bravo", start: 0, end: 5 });
    expect(selectionSpanForRow(rows[2]!, document, selection)).toBeUndefined();
    expect(selectionSpanForRow(rows[3]!, document, selection)).toEqual({ text: "charlie", start: 0, end: 3 });
  });
});
