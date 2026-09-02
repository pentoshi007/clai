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

export function flattenBlocks(blocks: readonly FeedBlock[]): readonly TranscriptWindowRow[] {
  const rows: TranscriptWindowRow[] = [];
  for (const [blockIndex, block] of blocks.entries()) {
    for (const [lineIndex, line] of block.lines.entries()) {
      rows.push({ key: `${block.key}:${lineIndex}`, line, block, lineIndex });
    }
    if (blockIndex < blocks.length - 1) {
      rows.push({ key: `${block.key}:gap`, line: "", block, lineIndex: undefined });
    }
  }
  return rows;
}

export function totalTranscriptRows(blocks: readonly FeedBlock[]): number {
  if (blocks.length === 0) return 0;
  let total = BLOCK_GAP_ROWS * (blocks.length - 1);
  for (const block of blocks) total += block.lines.length;
  return total;
}

export function planTranscriptWindow(
  flat: readonly TranscriptWindowRow[],
  budget: number,
  offsetFromBottom: number,
): TranscriptWindow {
  const viewportRows = Math.max(0, Math.floor(budget));
  const totalRows = flat.length;
  const maxOffset = Math.max(0, totalRows - viewportRows);
  const offset = Math.max(0, Math.min(Math.floor(offsetFromBottom), maxOffset));
  const end = totalRows - offset;
  const start = Math.max(0, end - viewportRows);
  const rows = viewportRows === 0 ? [] : flat.slice(start, end);
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
