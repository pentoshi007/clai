import type { FeedBlock } from "./feed-blocks.js";

export const BLOCK_GAP_ROWS = 1;

export function blockHeight(block: FeedBlock): number {
  return block.lines.length;
}

export function totalHeight(blocks: readonly FeedBlock[], gap = BLOCK_GAP_ROWS): number {
  if (blocks.length === 0) return 0;
  let sum = 0;
  for (const block of blocks) sum += blockHeight(block);
  return sum + gap * (blocks.length - 1);
}

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
