import type { FileChange, DiffLine } from "../../tools/file-diff.js";
import { buildModalLines, changeVerb } from "../../tools/file-diff.js";
import { relativeDisplayPath, syntaxColor } from "../../ui-core/rendering/file-diff-view.js";
import { emptyCarry, highlightLineForPath, type SyntaxSpan } from "../../ui-core/rendering/syntax-highlight.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { isFileDiffExpanded, isItemExpanded, type ToolItem } from "../../ui-core/state/transcript-types.js";
import { clipToWidth, expandTabs, sealStyle, trimTrailingSpaces } from "../render/ansi-text.js";
import { layoutWidth } from "../render/measure.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { clipRow, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { buildToolBodyLines, hintRows, toolGlyph, TOOL_STATUS_TOKEN } from "./tool-lines.js";

export const DIFF_PREVIEW_LINES = 3;
export const WRITE_MANY_LISTED_FILES = 12;
export const DIFF_INDENT = 4;
export const DIFF_TAB_WIDTH = 4;

function verb(item: ToolItem, change: FileChange | undefined): string {
  const kind = change?.kind ?? "edit";
  const status = item.status === "failed" || item.status === "blocked" ? "failed" : item.status === "ok" ? "ok" : "running";
  if (kind === "create" && status !== "failed") return status === "ok" ? "Added" : "Adding";
  if (kind === "overwrite" || kind === "append") return status === "ok" ? "Edited" : changeVerb(kind, status);
  return changeVerb(kind, status);
}

export function diffStatsSuffix(ctx: BlockContext, change: Pick<FileChange, "stats">): string {
  const added = ctx.ink.style(`+${change.stats.added}`, { fg: "success", bold: true });
  const removed = ctx.ink.style(`-${change.stats.removed}`, { fg: "diffDel", bold: true });
  return `(${added} ${removed})`;
}

export function diffTitleLine(ctx: BlockContext, item: ToolItem, change: FileChange | undefined): string {
  const changes = item.fileChanges ?? [];
  const token = TOOL_STATUS_TOKEN[item.status];
  const title = ctx.ink.style(verb(item, changes[0] ?? change), { fg: token, bold: true });
  const path = changes.length > 1 ? `${changes.length} files` : relativeDisplayPath(change?.path ?? item.argsDisplay);
  const label = ctx.ink.fg("inputBorder", sanitizeDisplayText(path));
  const suffix = change ? ` ${diffStatsSuffix(ctx, change)}` : "";
  const head = `${ctx.ink.fg(token, toolGlyph(ctx, item.status))} ${title} ${label}`;
  const budget = Math.max(1, ctx.width - layoutWidth(suffix));
  return clipRow(ctx, `${clipToWidth(head, budget, ctx.glyphs.ellipsis)}${suffix}`);
}

function carrier(changes: readonly FileChange[]): FileChange | undefined {
  if (changes.length === 0) return undefined;
  const added = changes.reduce((sum, change) => sum + change.stats.added, 0);
  const removed = changes.reduce((sum, change) => sum + change.stats.removed, 0);
  return { ...changes[0]!, stats: { ...changes[0]!.stats, added, removed } };
}

function sourceLines(change: FileChange, expanded: boolean): DiffLine[] {
  if (expanded && change.afterText !== undefined && change.truncated) {
    const allAdded = change.stats.added === change.stats.newLines;
    return buildModalLines(change).map((line) => ({
      op: allAdded && line.op === "context" ? "add" : line.op,
      text: line.text, oldLine: line.oldLineNo, newLine: line.lineNo,
    }));
  }
  return change.previewHunks.flatMap((hunk) => hunk.lines);
}

function codeText(ctx: BlockContext, spans: readonly SyntaxSpan[]): string {
  return spans.map((span) => ctx.ink.hex(syntaxColor(span.kind, ctx.ink.theme), span.text)).join("");
}

function diffRows(ctx: BlockContext, change: FileChange, expanded: boolean): string[] {
  if (change.binary) return [clipRow(ctx, "    (binary file)")];
  const source = sourceLines(change, expanded);
  if (source.length === 0) return [clipRow(ctx, "    (no line changes)")];
  const width = String(Math.max(change.stats.oldLines, change.stats.newLines, 1)).length;
  const carry = emptyCarry();
  const rows: string[] = [];
  const shown = expanded ? source : source.slice(0, DIFF_PREVIEW_LINES);
  for (const line of shown) {
    const number = line.op === "del" ? line.oldLine : line.newLine ?? line.oldLine;
    const gutter = number === undefined ? " ".repeat(width) : String(number).padStart(width, " ");
    const marker = line.op === "add" ? "+" : line.op === "del" ? "-" : " ";
    const token = line.op === "add" ? "diffAdd" : line.op === "del" ? "diffDel" : "diffGutter";
    const text = expandTabs(sanitizeDisplayText(line.text), DIFF_TAB_WIDTH);
    const spans = highlightLineForPath(text, change.path, carry);
    const code = codeText(ctx, spans);
    const codeWidth = Math.max(1, ctx.width - DIFF_INDENT - width - 3);
    const chunks = expanded ? wrapAnsiLine(code, codeWidth) : [clipToWidth(code, codeWidth, ctx.glyphs.ellipsis)];
    for (const [index, chunk] of chunks.entries()) {
      const prefix = index === 0 ? `${gutter} ${marker} ` : " ".repeat(width + 3);
      const body = `${" ".repeat(DIFF_INDENT)}${ctx.ink.fg(token, prefix)}${chunk}`;
      const wash = line.op === "add" ? "diffAddBg" : line.op === "del" ? "diffDelBg" : undefined;
      rows.push(trimTrailingSpaces(sealStyle(ctx.ink.washColor && wash ? ctx.ink.band(body, ctx.width, { bg: wash }) : body)));
    }
  }
  return rows;
}

function diffNotice(ctx: BlockContext, change: FileChange): string | undefined {
  if (!change.truncated || change.binary) return undefined;
  if (change.afterText === undefined) {
    return ctx.spool.fileChangeNotice?.(change) ?? "Full diff unavailable · retained preview shown";
  }
  const removed = change.deletedAt.reduce((count, segment) => count + segment.lines.length, 0);
  const missingMarkers = change.stats.added > change.addedNewLines.length && change.stats.added !== change.stats.newLines;
  if (removed < change.stats.removed || missingMarkers) return "Some diff details were not retained · full file shown";
  return undefined;
}

export function buildDiffLines(ctx: BlockContext, item: ToolItem): string[] {
  const changes = (item.fileChanges ?? []).map((change) => ctx.spool.fileChange?.(change) ?? change);
  const expanded = isItemExpanded(ctx.state, item);
  const showDiff = isFileDiffExpanded(ctx.state, item.id);
  const lines = [diffTitleLine(ctx, item, carrier(changes))];
  if (changes.length === 0) return [...lines, ...buildToolBodyLines({ ...ctx, lineOffset: lines.length }, item)];
  const listed = expanded ? changes : changes.slice(0, WRITE_MANY_LISTED_FILES);
  for (const [index, change] of listed.entries()) {
    if (changes.length > 1) {
      if (index > 0) lines.push("");
      const path = ctx.ink.fg("inputBorder", sanitizeDisplayText(relativeDisplayPath(change.path)));
      lines.push(clipRow(ctx, `  ${ctx.glyphs.bodyBranch} ${path} ${diffStatsSuffix(ctx, change)}`));
    }
    if (showDiff || expanded) lines.push(...diffRows(ctx, change, expanded));
    const notice = expanded ? diffNotice(ctx, change) : undefined;
    if (notice) lines.push(...hintRows(ctx, "    ", notice));
  }
  if (changes.length > listed.length) lines.push(clipRow(ctx, `    ${ctx.ink.fg("hint", `${changes.length - listed.length} more files`)}`));
  if (item.status === "failed" || item.status === "blocked") {
    return [...lines, ...buildToolBodyLines({ ...ctx, lineOffset: lines.length }, item)];
  }
  const hidden = changes.reduce((sum, change) => sum + Math.max(0, sourceLines(change, false).length - DIFF_PREVIEW_LINES), 0);
  appendDisclosure(ctx, lines, expanded, { hidden });
  return lines;
}
