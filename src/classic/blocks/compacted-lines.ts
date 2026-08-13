import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { liveCompactionHeadTail } from "../../ui-core/rendering/thinking-tail.js";
import {
  compactionTokenLabel,
  isItemExpanded,
  type CompactedItem,
} from "../../ui-core/state/transcript-types.js";
import { trimTrailingSpaces } from "../render/ansi-text.js";
import { wrapWithPrefixes } from "../render/wrap.js";
import { clipRow, joinMeta, type BlockContext } from "./block-context.js";
import { outputToggleLabel } from "./tool-lines.js";

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
  const indent = " ".repeat(BODY_INDENT);

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
    lines.push(clipRow(ctx, `${indent}${ctx.ink.fg("muted", outputToggleLabel(expanded))}`));
    return lines;
  }

  const summary = sanitizeDisplayText(
    item.streaming ? liveCompactionHeadTail(item.summary) : item.summary,
  ).trim();
  if (summary === "") {
    lines.push(clipRow(ctx, `${indent}${ctx.ink.fg("muted", outputToggleLabel(expanded))}`));
    return lines;
  }

  const budget = Math.max(1, ctx.width - BODY_INDENT);
  const rows = wrapWithPrefixes(summary, { width: budget });
  const cap = expanded ? rows.length : COMPACTED_PREVIEW_ROWS;
  const shown = rows.slice(0, cap);
  const branch = ctx.ink.fg("muted", `  ${ctx.glyphs.bodyBranch} `);

  for (const [index, row] of shown.entries()) {
    lines.push(
      trimTrailingSpaces(`${index === 0 ? branch : indent}${ctx.ink.fg("muted", row)}`),
    );
  }
  const footer = joinMeta(ctx, [
    outputToggleLabel(expanded),
    rows.length > shown.length ? `${ctx.glyphs.ellipsis} full memory` : undefined,
  ]);
  lines.push(clipRow(ctx, `${indent}${ctx.ink.fg("muted", footer)}`));
  return lines;
}
