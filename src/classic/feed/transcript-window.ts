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

export function totalTranscriptRows(blocks: readonly FeedBlock[]): number {
  if (blocks.length === 0) return 0;
  let total = BLOCK_GAP_ROWS * (blocks.length - 1);
  for (const block of blocks) total += block.lines.length;
  return total;
}

function sliceRows(
  blocks: readonly FeedBlock[],
  start: number,
  end: number,
): TranscriptWindowRow[] {
  const rows: TranscriptWindowRow[] = [];
  let cursor = 0;
  for (let blockIndex = 0; blockIndex < blocks.length && cursor < end; blockIndex += 1) {
    const block = blocks[blockIndex]!;
    const gap = blockIndex < blocks.length - 1 ? BLOCK_GAP_ROWS : 0;
    const span = block.lines.length + gap;
    if (cursor + span <= start) {
      cursor += span;
      continue;
    }
    const from = Math.max(0, start - cursor);
    const to = Math.min(span, end - cursor);
    for (let offset = from; offset < to; offset += 1) {
      rows.push(
        offset < block.lines.length
          ? { key: `${block.key}:${offset}`, line: block.lines[offset]!, block, lineIndex: offset }
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
  const totalRows = totalTranscriptRows(blocks);
  const maxOffset = Math.max(0, totalRows - viewportRows);
  const offset = Math.max(0, Math.min(Math.floor(offsetFromBottom), maxOffset));
  const end = totalRows - offset;
  const start = Math.max(0, end - viewportRows);
  const rows = viewportRows === 0 ? [] : sliceRows(blocks, start, end);
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
