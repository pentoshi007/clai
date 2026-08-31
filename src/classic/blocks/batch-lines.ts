import {
  batchSummaryLine,
  buildBatchCardsFromSpool,
  parseBatchSections,
  presentBatchSection,
  type BatchSection,
} from "../../ui-core/rendering/batch-sections.js";
import { isItemExpanded, type ToolItem } from "../../ui-core/state/transcript-types.js";
import { adaptPresenterGlyphs } from "../render/glyphs.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { alignEnds, trimTrailingSpaces } from "../render/ansi-text.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { clipRow, joinMeta, SUFFIX_MIN_COLUMNS, type BlockContext } from "./block-context.js";
import { outputToggleLabel, toolHeaderLines } from "./tool-lines.js";

export const BATCH_COLLAPSED_ROWS = 8;
const SUB_INDENT = 2;
const SUB_BODY_INDENT = 4;

const SECTION_TOKEN: Record<string, ThemeToken> = {
  running: "activity",
  ok: "success",
  fail: "diffDel",
  cancelled: "activity",
};

function sectionGlyph(ctx: BlockContext, status: string): string {
  if (status === "running") return ctx.glyphs.toolRunning;
  if (status === "ok") return ctx.glyphs.toolOk;
  if (status === "cancelled") return ctx.glyphs.toolBlocked;
  return ctx.glyphs.toolFailed;
}

export function batchSectionsFor(ctx: BlockContext, item: ToolItem): BatchSection[] {
  const tail = ctx.spool.tail(item.toolCallId);
  const open = item.status === "running" || item.status === "queued";
  if (open) return buildBatchCardsFromSpool(tail);
  const parsed = parseBatchSections(tail);
  return parsed.length > 0 ? parsed : buildBatchCardsFromSpool(tail);
}

export function buildBatchLines(ctx: BlockContext, item: ToolItem): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const sections = batchSectionsFor(ctx, item);
  const lines = toolHeaderLines(ctx, item);
  const subIndent = " ".repeat(SUB_INDENT);
  if (sections.length === 0) {
    lines.push(clipRow(ctx, `${subIndent}${ctx.ink.fg("muted", outputToggleLabel(expanded))}`));
    return lines;
  }

  const shown = expanded ? sections : sections.slice(0, BATCH_COLLAPSED_ROWS);
  const bodyIndent = " ".repeat(SUB_BODY_INDENT);

  for (const section of shown) {
    const status = section.status ?? (section.ok ? "ok" : "fail");
    const token = SECTION_TOKEN[status] ?? "muted";
    const presented = presentBatchSection(section, expanded);
    const glyph = ctx.ink.fg(token, sectionGlyph(ctx, status));
    const name = ctx.ink.fg("cyan", section.name);
    const suffix =
      ctx.width + 2 >= SUFFIX_MIN_COLUMNS && status === "running"
        ? ctx.ink.fg(token, presented.statusLabel)
        : "";
    lines.push(
      alignEnds(`${subIndent}${glyph} ${name}`, suffix, ctx.width, ctx.glyphs.ellipsis),
    );
    if (!expanded || !presented.hasBody) continue;
    const budget = Math.max(1, ctx.width - SUB_BODY_INDENT);
    const summaryRow = presented.lines.find((line) => line.trim().length > 0);
    if (summaryRow === undefined) continue;
    const text = adaptPresenterGlyphs(summaryRow, ctx.ink.unicode);
    for (const chunk of wrapAnsiLine(text, budget)) {
      lines.push(
        trimTrailingSpaces(`${bodyIndent}${ctx.ink.fg("foreground", chunk)}`),
      );
    }
  }

  const hidden = sections.length - shown.length;
  const summary = batchSummaryLine(sections);
  const footer = joinMeta(ctx, [
    outputToggleLabel(expanded),
    summary === "" ? undefined : summary,
    hidden > 0 ? `${ctx.glyphs.ellipsis} +${hidden} more` : undefined,
  ]);
  if (footer !== "") {
    lines.push(clipRow(ctx, `${subIndent}${ctx.ink.fg("muted", footer)}`));
  }
  return lines;
}
