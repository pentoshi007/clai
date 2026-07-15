/**
 * Content-driven composer height (classic parity for Shift+Enter multi-line).
 *
 * The shell passes a max text-row budget; the editor grows from 1 up to that
 * budget based on hard newlines and soft-wrap at the input width.
 */

import { wrapPlainString } from "../../tui/text-format.js";

/** Visual rows for the current prompt (newlines + width wrap). Empty → 1. */
export function countComposerVisualLines(text: string, wrapWidth: number): number {
  if (!text) return 1;
  return Math.max(1, wrapPlainString(text, Math.max(1, wrapWidth)).length);
}

/** Clamp content rows into the [min, max] budget. */
export function resolveComposerTextRows(
  contentLines: number,
  maxRows: number,
  minRows = 1,
): number {
  const min = Math.max(1, minRows);
  const max = Math.max(min, maxRows);
  return Math.min(max, Math.max(min, Math.max(1, contentLines)));
}

/**
 * Max editable text rows the terminal can spare while keeping a chat floor.
 * `borderRows` accounts for the rounded input chrome around the textarea.
 */
export function maxComposerTextRows(opts: {
  readonly terminalRows: number;
  readonly statusHeight: number;
  readonly minChatRows: number;
  readonly maxCap: number;
  readonly borderRows?: number;
}): number {
  const borders = opts.borderRows ?? 2;
  const budget =
    opts.terminalRows - opts.statusHeight - opts.minChatRows - borders;
  return Math.max(1, Math.min(opts.maxCap, budget));
}
