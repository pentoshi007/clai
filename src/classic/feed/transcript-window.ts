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
  readonly offset: number;
  readonly scrollAbove: number;
  readonly scrollBelow: number;
  readonly viewportRows: number;
  readonly firstItemId: string | undefined;
  readonly lastItemId: string | undefined;
  readonly visibleItemIds: ReadonlySet<string>;
}

interface TranscriptIndex {
  readonly starts: readonly number[];
  readonly totalRows: number;
}

const transcriptIndexes = new WeakMap<readonly FeedBlock[], TranscriptIndex>();

function transcriptIndex(blocks: readonly FeedBlock[]): TranscriptIndex {
  const cached = transcriptIndexes.get(blocks);
  if (cached) return cached;
  const starts: number[] = [];
  let totalRows = 0;
  for (let index = 0; index < blocks.length; index += 1) {
    starts.push(totalRows);
    totalRows += blocks[index]!.lines.length;
    if (index < blocks.length - 1) totalRows += BLOCK_GAP_ROWS;
  }
  const result = { starts, totalRows };
  transcriptIndexes.set(blocks, result);
  return result;
}

export function totalTranscriptRows(blocks: readonly FeedBlock[]): number {
  return transcriptIndex(blocks).totalRows;
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
    const gap = blockIndex < blocks.length - 1 ? BLOCK_GAP_ROWS : 0;
    const span = lines.length + gap;
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

export function planTranscriptWindow(
  blocks: readonly FeedBlock[],
  budget: number,
  offsetFromBottom: number,
): TranscriptWindow {
  const viewportRows = Math.max(0, Math.floor(budget));
  const index = transcriptIndex(blocks);
  const totalRows = index.totalRows;
  const maxOffset = Math.max(0, totalRows - viewportRows);
  const offset = Math.max(0, Math.min(Math.floor(offsetFromBottom), maxOffset));
  const end = totalRows - offset;
  const start = Math.max(0, end - viewportRows);
  const rows = viewportRows === 0 ? [] : sliceRows(blocks, index, start, end);
  const visibleItemIds = new Set<string>();
  for (const row of rows) visibleItemIds.add(row.block.itemId);
  return {
    rows,
    height: rows.length,
    totalRows,
    maxOffset,
    offset,
    scrollAbove: start,
    scrollBelow: offset,
    viewportRows,
    firstItemId: rows[0]?.block.itemId,
    lastItemId: rows.at(-1)?.block.itemId,
    visibleItemIds,
  };
}
