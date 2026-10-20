import type { SelectionState } from "../../ui-core/controllers/selection-controller.js";
import {
  compareSemanticAnchors,
  type SemanticAnchor,
  type SemanticBlock,
  type SemanticCell,
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

interface BlockTextLayout {
  readonly text: string;
  readonly lineStarts: readonly number[];
}

const layouts = new WeakMap<readonly string[], BlockTextLayout>();
const semanticBlocks = new WeakMap<FeedBlock, SemanticBlock>();

function blockLayout(block: FeedBlock): BlockTextLayout {
  const lines = block.lines ?? [];
  let layout = layouts.get(lines);
  if (!layout) {
    const plain = lines.map(displayLine);
    const lineStarts: number[] = [];
    let offset = 0;
    for (const line of plain) {
      lineStarts.push(offset);
      offset += line.length + 1;
    }
    layout = { text: plain.join("\n"), lineStarts };
    layouts.set(lines, layout);
  }
  return layout;
}

function blockText(block: FeedBlock): string {
  return blockLayout(block).text;
}

function semanticBlock(block: FeedBlock): SemanticBlock {
  let semantic = semanticBlocks.get(block);
  if (!semantic) {
    semantic = { id: block.key ?? block.itemId, get text() { return blockText(block); } };
    semanticBlocks.set(block, semantic);
  }
  return semantic;
}

export function classicTranscriptDocument(
  blocks: readonly FeedBlock[],
): SemanticDocument {
  return { blocks: blocks.map(semanticBlock) };
}

function lineStart(block: FeedBlock, lineIndex: number): number {
  const { lineStarts, text } = blockLayout(block);
  if (lineIndex < lineStarts.length) return lineStarts[Math.max(0, lineIndex)]!;
  const end = lineStarts.length > 0 ? text.length + 1 : 0;
  return end + lineIndex - lineStarts.length;
}

function cellAtColumn(text: string, column: number): { start: number; end: number } {
  const target = Math.max(0, column);
  let width = 0;
  let offset = 0;
  for (const grapheme of graphemes(text)) {
    const next = width + layoutWidth(grapheme);
    if (target < next) return { start: offset, end: offset + grapheme.length };
    width = next;
    offset += grapheme.length;
  }
  return { start: offset, end: offset };
}

function cellForRow(row: TranscriptWindowRow, column: number): SemanticCell {
  const blockId = row.block.key ?? row.block.itemId;
  if (row.lineIndex === undefined) {
    const end = { blockId, offset: blockText(row.block).length };
    return { start: end, end };
  }
  const base = lineStart(row.block, row.lineIndex);
  const cell = cellAtColumn(displayLine(row.line), column);
  return {
    start: { blockId, offset: base + cell.start },
    end: { blockId, offset: base + cell.end },
  };
}

export function cellAtTranscriptPointer(
  window: TranscriptWindow,
  x: number,
  y: number,
  geometry: TranscriptPointerGeometry,
  clamp = false,
): SemanticCell | undefined {
  if (window.rows.length === 0) return undefined;
  const relativeY = y - geometry.top;
  if (!clamp && (relativeY < 0 || relativeY >= window.viewportRows)) return undefined;
  const rowIndex = Math.max(0, Math.min(window.rows.length - 1, relativeY));
  const row = window.rows[rowIndex];
  if (!row) return undefined;
  return cellForRow(row, x - geometry.left);
}

export function anchorAtTranscriptPointer(
  window: TranscriptWindow,
  x: number,
  y: number,
  geometry: TranscriptPointerGeometry,
  clamp = false,
): SemanticAnchor | undefined {
  return cellAtTranscriptPointer(window, x, y, geometry, clamp)?.start;
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
