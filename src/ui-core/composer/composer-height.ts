
import { wrapPlainString } from "../rendering/text-format.js";

export function countComposerVisualLines(text: string, wrapWidth: number): number {
  if (!text) return 1;
  return Math.max(1, wrapPlainString(text, Math.max(1, wrapWidth)).length);
}

export function resolveComposerTextRows(
  contentLines: number,
  maxRows: number,
  minRows = 1,
): number {
  const min = Math.max(1, minRows);
  const max = Math.max(min, maxRows);
  return Math.min(max, Math.max(min, Math.max(1, contentLines)));
}

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
