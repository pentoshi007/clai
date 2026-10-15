import { clipToWidth } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import type { BlockContext } from "./block-context.js";

export interface BlockDisclosure {
  readonly lineIndex: number;
  readonly column: number;
  readonly width: number;
  readonly action?: "output";
}

export function outputToggleLabel(expanded: boolean): string {
  return expanded ? "- click to collapse" : "+ click to expand";
}

export function appendDisclosure(
  ctx: BlockContext,
  lines: string[],
  expanded: boolean,
  options: { hidden?: number; chord?: string; indent?: number; label?: string; action?: "output"; inline?: boolean } = {},
): void {
  const text = options.label ?? outputToggleLabel(expanded);
  const hidden = !expanded && options.hidden ? ` (${options.hidden} lines)` : "";
  const hint = `${hidden} ${ctx.glyphs.separator} ${options.chord ?? "Ctrl+O"}`;
  const head = options.inline ? lines.pop() ?? "" : "";
  const headBudget = Math.max(1, ctx.width - layoutWidth(text + hint) - 3);
  const prefix = options.inline ? `${clipToWidth(head, headBudget, ctx.glyphs.ellipsis)} ${ctx.glyphs.separator} ` : "";
  const column = options.inline ? layoutWidth(prefix) : Math.min(options.indent ?? 4, Math.max(0, ctx.width - 11));
  const label = clipToWidth(text, Math.max(0, ctx.width - column), ctx.glyphs.ellipsis);
  const suffix = clipToWidth(hint, Math.max(0, ctx.width - column - layoutWidth(label)), "");
  const lineIndex = (ctx.lineOffset ?? 0) + lines.length;
  lines.push(`${prefix || " ".repeat(column)}${ctx.ink.fg("hint", label)}${ctx.ink.fg("hint", suffix)}`.trimEnd());
  ctx.disclosures?.push({ lineIndex, column, width: layoutWidth(label), ...(options.action ? { action: options.action } : {}) });
}
