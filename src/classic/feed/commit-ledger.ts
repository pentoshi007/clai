import { BLOCK_GAP_ROWS, blockHeight } from "./block-height.js";
import type { FeedBlock } from "./feed-blocks.js";

export interface CommitDecision {
  readonly committed: readonly FeedBlock[];
  readonly live: readonly FeedBlock[];
  readonly committedCount: number;
}

export interface CommitInput {
  readonly blocks: readonly FeedBlock[];
  readonly liveBudgetRows: number;
  readonly committedCount: number;
  readonly turnBoundary: boolean;
  readonly currentTurnId?: string | undefined;
}

export function decideCommit(input: CommitInput): CommitDecision {
  const blocks = input.blocks;
  const floor = Math.min(Math.max(0, input.committedCount), blocks.length);

  let cut = floor;

  if (input.turnBoundary) {
    let boundary = floor;
    for (let index = floor; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      if (block.open) break;
      if (input.currentTurnId !== undefined && block.turnId === input.currentTurnId) break;
      boundary = index + 1;
    }
    cut = Math.max(cut, boundary);
  }

  const budget = Math.max(0, input.liveBudgetRows);
  let used = 0;
  let firstLive = blocks.length;
  for (let index = blocks.length - 1; index >= cut; index -= 1) {
    const block = blocks[index]!;
    const cost = blockHeight(block) + (firstLive < blocks.length ? BLOCK_GAP_ROWS : 0);
    if (used + cost > budget && !block.open) break;
    used += cost;
    firstLive = index;
  }

  cut = Math.max(cut, firstLive);

  for (let index = floor; index < cut; index += 1) {
    if (blocks[index]!.open) {
      cut = index;
      break;
    }
  }

  return {
    committed: blocks.slice(0, cut),
    live: blocks.slice(cut),
    committedCount: cut,
  };
}
