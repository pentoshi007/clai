import { BLOCK_GAP_ROWS } from "./block-height.js";
import type { FeedBlock } from "./feed-blocks.js";

export interface TranscriptWindowRow {
  readonly key: string;
  readonly line: string;
  readonly block: FeedBlock;
  readonly lineIndex: number | undefined;
}

export interface TranscriptWindow {
  readonly rows: readonly TranscriptWindowRow[];
  readonly height: number;
  readonly totalRows: number;
  readonly maxOffset: number;
  readonly layoutPending: boolean;
  readonly offset: number;
  readonly scrollAbove: number;
  readonly scrollBelow: number;
  readonly viewportRows: number;
  readonly firstItemId: string | undefined;
  readonly lastItemId: string | undefined;
  readonly visibleItemIds: ReadonlySet<string>;
}

export interface TranscriptRowAnchor {
  readonly blockKey: string;
  readonly lineIndex: number | undefined;
}

interface TranscriptIndex {
  readonly starts: readonly number[];
  readonly positions: ReadonlyMap<string, number>;
  readonly totalRows: number;
  readonly pending: readonly FeedBlock[];
}

const transcriptIndexes = new WeakMap<readonly FeedBlock[], TranscriptIndex>();

function gapAfter(blocks: readonly FeedBlock[], index: number): number {
  return index < blocks.length - 1 ? BLOCK_GAP_ROWS : 0;
}

function blockRows(block: FeedBlock): number {
  return block.rowCount ?? block.lines.length;
}

function transcriptIndex(blocks: readonly FeedBlock[]): TranscriptIndex {
  const cached = transcriptIndexes.get(blocks);
  if (cached && cached.pending.every((block) => block.layoutPending)) return cached;
  const starts: number[] = [];
  const positions = new Map<string, number>();
  let totalRows = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    starts.push(totalRows);
    positions.set(blocks[index]!.key, index);
    const rows = blockRows(blocks[index]!);
    totalRows += rows + gapAfter(blocks, index);
  }
  const result = { starts, positions, totalRows, pending: blocks.filter((block) => block.layoutPending) };
  transcriptIndexes.set(blocks, result);
  return result;
}

export function totalTranscriptRows(blocks: readonly FeedBlock[]): number {
  return transcriptIndex(blocks).totalRows;
}

export function offsetForTranscriptAnchor(
  blocks: readonly FeedBlock[],
  budget: number,
  anchor: TranscriptRowAnchor,
): number | undefined {
  const position = transcriptIndex(blocks).positions.get(anchor.blockKey);
  if (position === undefined) return undefined;
  measureBelow(blocks, position);
  const index = transcriptIndex(blocks);
  const block = blocks[position]!;
  const height = blockRows(block);
  const gap = gapAfter(blocks, position);
  const line = Math.max(0, Math.min(anchor.lineIndex ?? height, height + gap - 1));
  return index.totalRows - index.starts[position]! - line - Math.max(0, Math.floor(budget));
}

function firstVisibleBlock(starts: readonly number[], row: number): number {
  let lower = 0;
  let upper = starts.length;
  while (lower < upper) {
    const middle = Math.floor((lower + upper) / 2);
    if (starts[middle]! <= row) lower = middle + 1;
    else upper = middle;
  }
  return Math.max(0, lower - 1);
}

function sliceRows(
  blocks: readonly FeedBlock[],
  index: TranscriptIndex,
  start: number,
  end: number,
): TranscriptWindowRow[] {
  const rows: TranscriptWindowRow[] = [];
  if (start >= end) return rows;
  const first = firstVisibleBlock(index.starts, start);
  let cursor = index.starts[first] ?? 0;
  for (let blockIndex = first; blockIndex < blocks.length && cursor < end; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    const lines = block.lines;
    const span = lines.length + gapAfter(blocks, blockIndex);
    const from = Math.max(0, start - cursor);
    const to = Math.min(span, end - cursor);
    for (let offset = from; offset < to; offset += 1) {
      rows.push(
        offset < lines.length
          ? { key: `${block.key}:${offset}`, line: lines[offset]!, block, lineIndex: offset }
          : { key: `${block.key}:gap`, line: "", block, lineIndex: undefined },
      );
    }
    cursor += span;
  }
  return rows;
}

function measureFromBottom(blocks: readonly FeedBlock[], below: number, viewportRows: number): void {
  const rows = below + viewportRows;
  let covered = 0;
  for (let index = blocks.length - 1; index >= 0 && covered < rows; index -= 1) {
    const block = blocks[index]!;
    let height = blockRows(block);
    if (block.layoutPending) {
      height = covered >= below || !block.measure ? block.lines.length : block.measure();
    }
    covered += height + gapAfter(blocks, index);
  }
}

function measureBelow(blocks: readonly FeedBlock[], position: number): void {
  for (let index = position; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.layoutPending) block.measure?.();
  }
}

export function planTranscriptWindow(
  blocks: readonly FeedBlock[],
  budget: number,
  offsetFromBottom: number,
): TranscriptWindow {
  const viewportRows = Math.max(0, Math.floor(budget));
  const requestedOffset = Math.max(0, Math.floor(offsetFromBottom));
  measureFromBottom(blocks, requestedOffset, viewportRows);
  const index = transcriptIndex(blocks);
  const totalRows = index.totalRows;
  const maxOffset = Math.max(0, totalRows - viewportRows);
  const offset = Math.min(requestedOffset, maxOffset);
  const start = Math.max(0, totalRows - offset - viewportRows);
  const rows = viewportRows === 0 ? [] : sliceRows(blocks, index, start, totalRows - offset);
  const visibleItemIds = new Set<string>();
  for (const row of rows) visibleItemIds.add(row.block.itemId);
  return {
    rows,
    height: rows.length,
    totalRows,
    maxOffset,
    layoutPending: index.pending.length > 0,
    offset,
    scrollAbove: start,
    scrollBelow: offset,
    viewportRows,
    firstItemId: rows[0]?.block.itemId,
    lastItemId: rows.at(-1)?.block.itemId,
    visibleItemIds,
  };
}
