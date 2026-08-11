import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { liveCompactionHeadTail } from "../../ui-core/rendering/thinking-tail.js";
import {
  compactionTokenLabel,
  isItemExpanded,
  type CompactedItem,
} from "../../ui-core/state/transcript-types.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, joinMeta, type BlockContext } from "./block-context.js";
import { trimTrailingSpaces } from "../render/ansi-text.js";

/** Summary rows shown in the collapsed card (OpenTUI parity). */
export const COMPACTED_PREVIEW_ROWS = 4;
const BODY_INDENT = 4;

export function buildCompactedLines(ctx: BlockContext, item: CompactedItem): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const label = compactionTokenLabel(item);
  const glyph = ctx.ink.fg("cyan", ctx.glyphs.compacted);
  const head = joinMeta(ctx, [
    item.error ? "Compaction failed" : "Compacted context",
    label === "" ? undefined : label,
  ]);
  const headRows = wrapWithPrefixes(head, { width: Math.max(1, ctx.width - 2) });
  const lines = headRows.map((row, index) =>
    trimTrailingSpaces(
      `${index === 0 ? `${glyph} ` : "  "}${ctx.ink.fg(item.error ? "activity" : "cyan", row)}`,
    ),
  );

  if (item.error) {
    const branch = ctx.ink.fg("muted", `  ${ctx.glyphs.bodyBranch} `);
    const indent = " ".repeat(BODY_INDENT);
    const errorRows = wrapWithPrefixes(sanitizeDisplayText(item.error), {
      width: Math.max(1, ctx.width - BODY_INDENT),
    });
    for (const [index, row] of errorRows.entries()) {
      lines.push(
        trimTrailingSpaces(
          `${index === 0 ? branch : indent}${ctx.ink.fg("activity", row)}`,
        ),
      );
    }
    return lines;
  }

  const summary = sanitizeDisplayText(
    item.streaming ? liveCompactionHeadTail(item.summary) : item.summary,
  ).trim();
  if (summary === "") return lines;

  const budget = Math.max(1, ctx.width - BODY_INDENT);
  const rows = wrapWithPrefixes(summary, { width: budget });
  const cap = expanded ? rows.length : COMPACTED_PREVIEW_ROWS;
  const shown = rows.slice(0, cap);
  const branch = ctx.ink.fg("muted", `  ${ctx.glyphs.bodyBranch} `);
  const indent = " ".repeat(BODY_INDENT);

  for (const [index, row] of shown.entries()) {
    lines.push(
      trimTrailingSpaces(`${index === 0 ? branch : indent}${ctx.ink.fg("muted", row)}`),
    );
  }
  if (rows.length > shown.length) {
    lines.push(
      clipRow(
        ctx,
        `${indent}${ctx.ink.fg("muted", joinMeta(ctx, [`${ctx.glyphs.ellipsis} full memory`, "^O"]))}`,
      ),
    );
  }
  return lines;
}
