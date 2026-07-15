import { describe, expect, it } from "vitest";
import {
  clampSemanticAnchor,
  compareSemanticAnchors,
  documentEnd,
  documentStart,
  moveSemanticAnchor,
  normalizeSemanticDocument,
  semanticLineRange,
  semanticRangeText,
  semanticWordRange,
  SEMANTIC_BLOCK_SEPARATOR,
  type SemanticDocument,
} from "../../../src/tui-v2/state/semantic-document.js";

function twoBlockDoc(): SemanticDocument {
  return {
    blocks: [
      { id: "a", text: "one two\nthree" },
      { id: "b", text: "four five" },
    ],
  };
}

describe("semantic-document (V2-060)", () => {
  it("rejects duplicate block ids and blocks missing an id", () => {
    expect(() => normalizeSemanticDocument({ blocks: [{ id: "x", text: "a" }, { id: "x", text: "b" }] })).toThrow();
    expect(() => normalizeSemanticDocument({ blocks: [{ id: "", text: "a" }] })).toThrow();
  });

  it("clamps an anchor into range and falls back to document start/end for a missing block", () => {
    const doc = twoBlockDoc();
    expect(clampSemanticAnchor(doc, { blockId: "a", offset: -5 })).toEqual({ blockId: "a", offset: 0 });
    expect(clampSemanticAnchor(doc, { blockId: "a", offset: 999 })).toEqual({ blockId: "a", offset: 13 });
    expect(clampSemanticAnchor(doc, { blockId: "missing", offset: 3 }, "start")).toEqual(documentStart(doc));
    expect(clampSemanticAnchor(doc, { blockId: "missing", offset: 3 }, "end")).toEqual(documentEnd(doc));
  });

  it("compares anchors by block order then offset", () => {
    const doc = twoBlockDoc();
    expect(compareSemanticAnchors(doc, { blockId: "a", offset: 5 }, { blockId: "b", offset: 0 })).toBeLessThan(0);
    expect(compareSemanticAnchors(doc, { blockId: "a", offset: 5 }, { blockId: "a", offset: 2 })).toBeGreaterThan(0);
    expect(compareSemanticAnchors(doc, { blockId: "a", offset: 2 }, { blockId: "a", offset: 2 })).toBe(0);
  });

  it("extracts range text within one block and across multiple blocks", () => {
    const doc = twoBlockDoc();
    expect(semanticRangeText(doc, { anchor: { blockId: "a", offset: 0 }, focus: { blockId: "a", offset: 3 } })).toBe("one");
    expect(
      semanticRangeText(doc, { anchor: { blockId: "a", offset: 4 }, focus: { blockId: "b", offset: 4 } }),
    ).toBe(`two\nthree${SEMANTIC_BLOCK_SEPARATOR}four`);
    // Order-independent: focus before anchor still returns the same forward text.
    expect(
      semanticRangeText(doc, { anchor: { blockId: "b", offset: 4 }, focus: { blockId: "a", offset: 4 } }),
    ).toBe(`two\nthree${SEMANTIC_BLOCK_SEPARATOR}four`);
  });

  it("does not move left past the first block or right past the last block", () => {
    const doc = twoBlockDoc();
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 0 }, "left")).toEqual({ blockId: "a", offset: 0 });
    expect(moveSemanticAnchor(doc, { blockId: "b", offset: 9 }, "right")).toEqual({ blockId: "b", offset: 9 });
  });

  it("crosses a block boundary for character and word movement", () => {
    const doc = twoBlockDoc();
    expect(moveSemanticAnchor(doc, { blockId: "b", offset: 0 }, "left")).toEqual({ blockId: "a", offset: 13 });
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 13 }, "right")).toEqual({ blockId: "b", offset: 0 });
    expect(moveSemanticAnchor(doc, { blockId: "b", offset: 0 }, "word-left")).toEqual({ blockId: "a", offset: 8 });
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 9 }, "word-right")).toEqual({ blockId: "b", offset: 4 });
  });

  it("computes line-start/line-end within a multi-line block", () => {
    const doc = twoBlockDoc();
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 5 }, "line-start")).toEqual({ blockId: "a", offset: 0 });
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 5 }, "line-end")).toEqual({ blockId: "a", offset: 7 });
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 10 }, "line-start")).toEqual({ blockId: "a", offset: 8 });
  });

  it("preserves column across up/down movement, including across a block boundary", () => {
    const doc: SemanticDocument = {
      blocks: [
        { id: "a", text: "ab\nabcdef" },
        { id: "b", text: "xy" },
      ],
    };
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 1 }, "down")).toEqual({ blockId: "a", offset: 4 });
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 4 }, "up")).toEqual({ blockId: "a", offset: 1 });
    // Column 1 on the last line of block "a" (offset 4) moving down clamps
    // into the shorter block "b" line rather than throwing.
    expect(moveSemanticAnchor(doc, { blockId: "a", offset: 9 }, "down")).toEqual({ blockId: "b", offset: 2 });
  });

  it("selects a plain word boundary and clamps a click past the block end", () => {
    const doc = twoBlockDoc();
    expect(semanticWordRange(doc, { blockId: "a", offset: 5 })).toEqual({
      anchor: { blockId: "a", offset: 4 },
      focus: { blockId: "a", offset: 7 },
    });
    expect(semanticWordRange(doc, { blockId: "b", offset: 999 })).toEqual({
      anchor: { blockId: "b", offset: 5 },
      focus: { blockId: "b", offset: 9 },
    });
  });

  it("returns a zero-width range when clicking whitespace, not the neighboring word", () => {
    const doc: SemanticDocument = { blocks: [{ id: "a", text: "one two" }] };
    const range = semanticWordRange(doc, { blockId: "a", offset: 3 });
    expect(range).toEqual({ anchor: { blockId: "a", offset: 3 }, focus: { blockId: "a", offset: 3 } });
  });

  it("SEL-005: double-click on a URL or absolute file path selects the whole span, not one word-chunk", () => {
    const doc: SemanticDocument = {
      blocks: [{ id: "a", text: "see https://example.com/docs/page.html for /tmp/report.log details" }],
    };
    const text = doc.blocks[0]!.text;
    const urlOffset = text.indexOf("example");
    expect(semanticWordRange(doc, { blockId: "a", offset: urlOffset })).toEqual({
      anchor: { blockId: "a", offset: text.indexOf("https://") },
      focus: { blockId: "a", offset: text.indexOf(" for") },
    });
    const pathOffset = text.indexOf("report.log");
    expect(semanticWordRange(doc, { blockId: "a", offset: pathOffset })).toEqual({
      anchor: { blockId: "a", offset: text.indexOf("/tmp/report.log") },
      focus: { blockId: "a", offset: text.indexOf(" details") },
    });
  });

  it("selects a full logical line including a non-final block's trailing newline", () => {
    const doc = twoBlockDoc();
    expect(semanticLineRange(doc, { blockId: "a", offset: 0 })).toEqual({
      anchor: { blockId: "a", offset: 0 },
      focus: { blockId: "a", offset: 8 },
    });
    expect(semanticLineRange(doc, { blockId: "a", offset: 10 })).toEqual({
      anchor: { blockId: "a", offset: 8 },
      focus: { blockId: "a", offset: 13 },
    });
  });
});
