import type { SelectionState } from "../../ui-core/controllers/selection-controller.js";
import {
  compareSemanticAnchors,
  type SemanticAnchor,
  type SemanticDocument,
} from "../../ui-core/state/semantic-document.js";
import type { FeedBlock } from "./feed-blocks.js";
import type { TranscriptWindow, TranscriptWindowRow } from "./transcript-window.js";
import { graphemes, plainText } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";

export interface TranscriptPointerGeometry {
  readonly left: number;
  readonly top: number;
}

export interface SelectionSpan {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function displayLine(line: string): string {
  return plainText(line).replace(/[ \t]+$/, "");
}

function blockText(block: FeedBlock): string {
  return (block.lines ?? []).map(displayLine).join("\n");
}

export function classicTranscriptDocument(
  blocks: readonly FeedBlock[],
): SemanticDocument {
  return {
    blocks: blocks.map((block) => ({ id: block.key ?? block.itemId, text: blockText(block) })),
  };
}

function lineStart(block: FeedBlock, lineIndex: number): number {
  let offset = 0;
  for (let index = 0; index < lineIndex; index += 1) {
    offset += displayLine(block.lines[index] ?? "").length + 1;
  }
  return offset;
}

function offsetAtColumn(text: string, column: number): number {
  const target = Math.max(0, column);
  let width = 0;
  let offset = 0;
  for (const grapheme of graphemes(text)) {
    const next = width + layoutWidth(grapheme);
    if (target < next) break;
    width = next;
    offset += grapheme.length;
  }
  return offset;
}

function anchorForRow(row: TranscriptWindowRow, column: number): SemanticAnchor {
  const blockId = row.block.key ?? row.block.itemId;
  if (row.lineIndex === undefined) {
    return { blockId, offset: blockText(row.block).length };
  }
  const text = displayLine(row.line);
  return {
    blockId,
    offset: lineStart(row.block, row.lineIndex) + offsetAtColumn(text, column),
  };
}

export function anchorAtTranscriptPointer(
  window: TranscriptWindow,
  x: number,
  y: number,
  geometry: TranscriptPointerGeometry,
  clamp = false,
): SemanticAnchor | undefined {
  if (window.rows.length === 0) return undefined;
  const relativeY = y - geometry.top;
  if (!clamp && (relativeY < 0 || relativeY >= window.viewportRows)) return undefined;
  const rowIndex = Math.max(0, Math.min(window.rows.length - 1, relativeY));
  const row = window.rows[rowIndex];
  if (!row) return undefined;
  return anchorForRow(row, x - geometry.left);
}

function orderedRange(
  document: SemanticDocument,
  state: SelectionState,
): readonly [SemanticAnchor, SemanticAnchor] | undefined {
  const range = state.range;
  if (!range || range.pane !== "transcript") return undefined;
  return compareSemanticAnchors(document, range.anchor, range.focus) <= 0
    ? [range.anchor, range.focus]
    : [range.focus, range.anchor];
}

export function selectionSpanForRow(
  row: TranscriptWindowRow,
  document: SemanticDocument,
  state: SelectionState,
): SelectionSpan | undefined {
  if (row.lineIndex === undefined) return undefined;
  const range = orderedRange(document, state);
  if (!range) return undefined;
  const text = displayLine(row.line);
  const startOffset = lineStart(row.block, row.lineIndex);
  const blockId = row.block.key ?? row.block.itemId;
  const rowStart = { blockId, offset: startOffset };
  const rowEnd = { blockId, offset: startOffset + text.length };
  const [selectionStart, selectionEnd] = range;
  if (
    compareSemanticAnchors(document, selectionEnd, rowStart) <= 0 ||
    compareSemanticAnchors(document, selectionStart, rowEnd) >= 0
  ) {
    return undefined;
  }
  const start =
    compareSemanticAnchors(document, selectionStart, rowStart) <= 0
      ? 0
      : Math.max(0, selectionStart.offset - startOffset);
  const end =
    compareSemanticAnchors(document, selectionEnd, rowEnd) >= 0
      ? text.length
      : Math.min(text.length, selectionEnd.offset - startOffset);
  if (end <= start) return undefined;
  return { text, start, end };
}
