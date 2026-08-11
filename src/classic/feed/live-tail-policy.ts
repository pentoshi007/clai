import { clipRow, type BlockContext } from "../blocks/block-context.js";
import { BLOCK_GAP_ROWS } from "./block-height.js";
import type { FeedBlock } from "./feed-blocks.js";

/** Rows an open assistant block keeps when it does not fit (03-RENDER-MODEL §6). */
export const ASSISTANT_LIVE_ROWS = 12;
/** Output rows kept from an open tool body, on top of the header row. */
export const TOOL_LIVE_BODY_ROWS = 8;
/** Hunk rows kept from an open diff body, on top of the header row. */
export const DIFF_LIVE_HUNK_ROWS = 8;

export interface BoundedBlock {
  readonly lines: readonly string[];
  readonly truncated: boolean;
}

/**
 * Bound an open block to the rows the live region can give it. The bounded form
 * never reaches scrollback — the committed copy is always the complete one.
 */
export function boundOpenBlock(
  ctx: BlockContext,
  block: FeedBlock,
  budget: number,
): BoundedBlock {
  if (budget <= 0) return { lines: [], truncated: block.lines.length > 0 };
  if (block.lines.length <= budget) return { lines: block.lines, truncated: false };
  if (budget < 2) return { lines: block.lines.slice(0, budget), truncated: true };

  const header = block.lines[0] ?? "";
  const body = block.lines.slice(1);

  switch (block.kind) {
    case "assistant": {
      const rows = Math.min(budget - 1, ASSISTANT_LIVE_ROWS);
      const marker = clipRow(ctx, ctx.ink.fg("muted", `${ctx.glyphs.ellipsis} streaming`));
      return { lines: [marker, ...block.lines.slice(-rows)], truncated: true };
    }
    case "thinking":
      return { lines: block.lines.slice(-budget), truncated: true };
    case "tool":
      return {
        lines: [header, ...body.slice(-Math.min(budget - 1, TOOL_LIVE_BODY_ROWS))],
        truncated: true,
      };
    case "diff":
      return {
        lines: [header, ...body.slice(0, Math.min(budget - 1, DIFF_LIVE_HUNK_ROWS))],
        truncated: true,
      };
    default:
      return { lines: block.lines.slice(0, budget), truncated: true };
  }
}

export interface LiveTailRow {
  readonly key: string;
  readonly block: FeedBlock;
  readonly lines: readonly string[];
}

export interface LiveTailPlan {
  readonly rows: readonly LiveTailRow[];
  /** Rows the plan occupies; always `<= budget`. */
  readonly height: number;
  /** True when content above the first visible row was dropped. */
  readonly clipped: boolean;
  readonly hiddenAbove: number;
}

/**
 * Fit live blocks into exactly the rows the allocator granted, newest last.
 * Pure so `frame-height` and invariant tests can assert it without Ink.
 */
export function planLiveTail(
  ctx: BlockContext,
  live: readonly FeedBlock[],
  budget: number,
): LiveTailPlan {
  if (budget <= 0 || live.length === 0) {
    return { rows: [], height: 0, clipped: live.length > 0, hiddenAbove: live.length };
  }

  const rows: LiveTailRow[] = [];
  let used = 0;
  let index = live.length - 1;

  for (; index >= 0; index -= 1) {
    const block = live[index]!;
    const gap = rows.length > 0 ? BLOCK_GAP_ROWS : 0;
    const remaining = budget - used - gap;
    if (remaining <= 0) break;
    const bounded = block.open
      ? boundOpenBlock(ctx, block, remaining)
      : { lines: block.lines.slice(0, remaining), truncated: block.lines.length > remaining };
    if (bounded.lines.length === 0) break;
    rows.unshift({ key: block.key, block, lines: bounded.lines });
    used += bounded.lines.length + gap;
    if (bounded.truncated) {
      index -= 1;
      break;
    }
  }

  return {
    rows,
    height: used,
    clipped: index >= 0,
    hiddenAbove: Math.max(0, index + 1),
  };
}
