import { buildBatchCardsFromSpool, parseBatchSections, batchSummaryLine, type BatchSection } from "../../ui-core/rendering/batch-sections.js";
import { isItemExpanded, type ToolItem, type ToolStatus } from "../../ui-core/state/transcript-types.js";
import { parseFsReadSections } from "../../tools/fs/read-sections.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { adaptPresenterGlyphs } from "../render/glyphs.js";
import { clipRow, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { classicToolLabel } from "./tool-label.js";
import { logicalOutputLines, outputBodyRows } from "./output-lines.js";
import { buildToolLines, toolHeaderLines, toolGlyph, TOOL_STATUS_TOKEN } from "./tool-lines.js";

export const BATCH_COLLAPSED_ROWS = 3;

export function batchSectionsFor(ctx: BlockContext, item: ToolItem): BatchSection[] {
  const tail = ctx.spool.tail(item.toolCallId);
  const open = item.status === "running" || item.status === "queued";
  if (open) return buildBatchCardsFromSpool(tail);
  const parsed = parseBatchSections(tail);
  return parsed.length > 0 ? parsed : buildBatchCardsFromSpool(tail);
}

function readPathLine(ctx: BlockContext, path: string, ok: boolean): string {
  const label = ctx.ink.fg(ok ? "inputBorder" : "diffDel", sanitizeDisplayText(path).replace(/\n/g, " "));
  return clipRow(ctx, `    ${ctx.ink.fg("toolOutput", "Read")} ${label}`);
}

function compactReadLines(ctx: BlockContext, section: BatchSection): string[] {
  const files = parseFsReadSections(section.body);
  if (files.length === 0) {
    const path = section.body.match(/^# fs\.read path=(.+?)(?= (?:lines|pattern|bytes)=|$)/m)?.[1];
    if (path) return [readPathLine(ctx, path, section.ok)];
    return outputBodyRows(ctx, logicalOutputLines(section.body, section.name), false, { branch: false });
  }
  return files.flatMap((file) => {
    const lines = [readPathLine(ctx, file.path, file.ok)];
    if (!file.ok) lines.push(...outputBodyRows(ctx, logicalOutputLines(file.body, section.name), false, { token: "diffDel", branch: false }));
    return lines;
  });
}

export function buildBatchLines(ctx: BlockContext, item: ToolItem): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const sections = batchSectionsFor(ctx, item);
  if (sections.length === 0) return buildToolLines(ctx, item);
  const lines = toolHeaderLines(ctx, item);
  const shown = expanded ? sections : sections.slice(0, BATCH_COLLAPSED_ROWS);
  for (const [index, section] of shown.entries()) {
    const status: ToolStatus = section.status === "fail" ? "failed" : section.status === "cancelled" ? "blocked" : section.status;
    const token = section.status === "cancelled" ? "muted" : TOOL_STATUS_TOKEN[status];
    const tool = { ...item, name: section.name, status };
    const name = ctx.ink.fg(token, classicToolLabel(tool));
    const glyph = ctx.ink.fg(token, toolGlyph(ctx, status));
    const prefix = index === 0 ? `  ${ctx.glyphs.bodyBranch} ` : "    ";
    const exit = section.exitCode && section.exitCode !== 0 ? ` (exit ${section.exitCode})` : "";
    lines.push(clipRow(ctx, `${prefix}${glyph} ${name}${exit}`));
    if (expanded) lines.push(...outputBodyRows(ctx, logicalOutputLines(section.body, section.name), true, { branch: false }));
    else if (section.name === "fs.read") lines.push(...compactReadLines(ctx, section));
  }
  const summary = adaptPresenterGlyphs(batchSummaryLine(sections, "glyph"), ctx.ink.unicode);
  if (summary) lines.push(clipRow(ctx, `    ${ctx.ink.fg("hint", summary)}`));
  appendDisclosure(ctx, lines, expanded, { hidden: Math.max(0, sections.length - shown.length) });
  return lines;
}
