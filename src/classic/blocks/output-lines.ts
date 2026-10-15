import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { terminalOutputLines } from "../../ui-core/rendering/terminal-output.js";
import { clipToWidth, expandTabs, trimTrailingSpaces } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import { wrapAnsiLine } from "../render/wrap.js";
import type { ThemeToken } from "../render/ink-theme.js";
import type { BlockContext } from "./block-context.js";

export const OUTPUT_PREVIEW_LINES = 3;
export const PREVIEW_LINE_CHARS = 16 * 1024;

export function logicalOutputLines(raw: string, name = ""): string[] {
  const terminal = terminalOutputLines(raw, name);
  const safe = terminal ? [...terminal] : sanitizeDisplayText(raw).replace(/\^\[\[[0-9;?]*[ -/]*[@-~]/g, "").split("\n");
  while (safe.length > 0 && safe.at(-1) === "") safe.pop();
  return safe;
}

export function outputBodyRows(
  ctx: BlockContext,
  source: readonly string[],
  expanded: boolean,
  options: { token?: ThemeToken; maxLines?: number; branch?: boolean } = {},
): string[] {
  const token = options.token ?? "toolOutput";
  const shown = expanded ? source : source.slice(0, options.maxLines ?? OUTPUT_PREVIEW_LINES);
  const budget = Math.max(1, ctx.width - 4);
  const rows: string[] = [];
  for (const [index, raw] of shown.entries()) {
    const bounded = expanded ? raw : raw.slice(0, PREVIEW_LINE_CHARS);
    const text = expandTabs(bounded);
    const chunks = expanded ? wrapAnsiLine(text, budget) : [clipToWidth(text, budget, ctx.glyphs.ellipsis)];
    if (!expanded && raw.length > bounded.length && layoutWidth(chunks[0]!) < budget) {
      chunks[0] = clipToWidth(`${chunks[0]}${ctx.glyphs.ellipsis}`, budget, ctx.glyphs.ellipsis);
    }
    for (const [row, chunk] of chunks.entries()) {
      const first = options.branch !== false && index === 0 && row === 0;
      const prefix = first ? ctx.ink.fg(token, `  ${ctx.glyphs.bodyBranch} `) : "    ";
      rows.push(trimTrailingSpaces(`${prefix}${ctx.ink.fg(token, chunk)}`));
    }
  }
  return rows;
}
