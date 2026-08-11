import type { FeedBlock } from "./feed-blocks.js";

/** One blank row separates committed blocks; nothing inside a block. */
export const BLOCK_GAP_ROWS = 1;

export function blockHeight(block: FeedBlock): number {
  return block.lines.length;
}

/** Rows a run of blocks occupies once inter-block gaps are counted. */
export function totalHeight(blocks: readonly FeedBlock[], gap = BLOCK_GAP_ROWS): number {
  if (blocks.length === 0) return 0;
  let sum = 0;
  for (const block of blocks) sum += blockHeight(block);
  return sum + gap * (blocks.length - 1);
}

/**
 * Newest-first walk: how many trailing blocks fit in `budget` rows. Always at
 * least one when the budget is positive, so the newest block is never dropped
 * entirely — the live-tail policy bounds it instead.
 */
export function trailingBlocksWithin(
  blocks: readonly FeedBlock[],
  budget: number,
  gap = BLOCK_GAP_ROWS,
): number {
  if (blocks.length === 0 || budget <= 0) return 0;
  let used = 0;
  let kept = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const cost = blockHeight(blocks[index]!) + (kept > 0 ? gap : 0);
    if (used + cost > budget) break;
    used += cost;
    kept += 1;
  }
  return Math.max(kept, 1);
}
