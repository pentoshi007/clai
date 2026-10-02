import type { FileChange } from "../../tools/file-diff.js";
import {
  collapsedFileChangeLabel,
  gutterWidth,
  presentFileChangePreview,
  relativeDisplayPath,
  syntaxColor,
  type PresentedDiffRow,
} from "../../ui-core/rendering/file-diff-view.js";
import { presentTool } from "../../ui-core/rendering/tool-presenter.js";
import {
  isFileDiffExpanded,
  isItemExpanded,
  type ToolItem,
} from "../../ui-core/state/transcript-types.js";
import { alignEnds, clipToWidth, sealStyle, trimTrailingSpaces } from "../render/ansi-text.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { clipRow, SUFFIX_MIN_COLUMNS, type BlockContext } from "./block-context.js";
import { hintRows, outputToggleLabel, toolGlyph } from "./tool-lines.js";

export const SINGLE_FILE_PREVIEW_ROWS = 40;
export const WRITE_MANY_PREVIEW_ROWS = 8;
export const WRITE_MANY_LISTED_FILES = 12;
export const DIFF_INDENT = 2;
export const DIFF_TAB_WIDTH = 4;
const GUTTER_RULE_WIDTH = 3;
const CLICK_HINT = " · click for full";

const STATUS_TOKEN: Record<ToolItem["status"], ThemeToken> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "activity",
};

type ChangeKind = FileChange["kind"];

function changeMark(ctx: BlockContext, kind: ChangeKind): { mark: string; token: ThemeToken } {
  if (kind === "create") return { mark: "+", token: "success" };
  if (kind === "overwrite") return { mark: "~", token: "activity" };
  return { mark: ctx.glyphs.separator, token: "toolOutput" };
}

function washToken(tone: PresentedDiffRow["tone"]): ThemeToken | undefined {
  if (tone === "add") return "diffAddBg";
  if (tone === "del") return "diffDelBg";
  return undefined;
}

function syntaxCode(ctx: BlockContext, row: PresentedDiffRow): string {
  if (ctx.ink.colorMode === "none") return row.displayText;
  let out = "";
  for (const span of row.spans) out += ctx.ink.hex(syntaxColor(span.kind, ctx.ink.theme), span.text);
  return out;
}

function mutedCode(ctx: BlockContext, text: string): string {
  return ctx.ink.style(text, { fg: "muted", dim: true });
}

function gutterCell(ctx: BlockContext, row: PresentedDiffRow): string {
  const rail = row.tone === "add" ? "diffAdd" : row.tone === "del" ? "diffDel" : "diffGutter";
  return `${ctx.ink.fg("diffGutter", `${row.gutter} `)}${ctx.ink.fg(rail, `${ctx.glyphs.boxVertical} `)}`;
}

function quietText(row: PresentedDiffRow): string {
  return row.tone === "gap" ? row.displayText.replace(CLICK_HINT, "") : row.displayText;
}

function washedRow(ctx: BlockContext, row: PresentedDiffRow, rowWidth: number): string {
  const gutter = gutterCell(ctx, row);
  const line = clipToWidth(`${gutter}${markedBody(ctx, row)}`, rowWidth, ctx.glyphs.ellipsis);
  const wash = washToken(row.tone);
  return wash ? ctx.ink.band(line, rowWidth, { bg: wash }) : line;
}

function markedRow(ctx: BlockContext, row: PresentedDiffRow, rowWidth: number): string {
  const gutter = gutterCell(ctx, row);
  return clipToWidth(`${gutter}${markedBody(ctx, row)}`, rowWidth, ctx.glyphs.ellipsis);
}

function markedBody(ctx: BlockContext, row: PresentedDiffRow): string {
  if (row.tone === "context") return `  ${syntaxCode(ctx, row)}`;
  if (row.tone !== "add" && row.tone !== "del") return `  ${mutedCode(ctx, quietText(row))}`;
  const marker = row.prefix === "−" ? "-" : row.prefix;
  const token: ThemeToken = row.tone === "add" ? "diffAdd" : "diffDel";
  return `${ctx.ink.style(marker, { fg: token, bold: true })} ${syntaxCode(ctx, row)}`;
}

function diffRowLine(ctx: BlockContext, row: PresentedDiffRow): string {
  const rowWidth = Math.max(1, ctx.width - DIFF_INDENT);
  const body = ctx.ink.washColor ? washedRow(ctx, row, rowWidth) : markedRow(ctx, row, rowWidth);
  return trimTrailingSpaces(sealStyle(`${" ".repeat(DIFF_INDENT)}${body}`));
}

function codeBudget(ctx: BlockContext, change: FileChange): number {
  const marker = 2;
  return Math.max(8, ctx.width - DIFF_INDENT - gutterWidth(change) - GUTTER_RULE_WIDTH - marker);
}

export function diffStatsSuffix(ctx: BlockContext, change: FileChange): string {
  const minus = ctx.ink.unicode ? "−" : "-";
  const added = ctx.ink.style(`+${change.stats.added}`, { fg: "success", bold: true });
  const removed = ctx.ink.style(`${minus}${change.stats.removed}`, { fg: "diffDel", bold: true });
  return `${added} ${removed}`;
}

function totalStats(changes: readonly FileChange[]): FileChange["stats"] | undefined {
  if (changes.length === 0) return undefined;
  if (changes.length === 1) return changes[0]!.stats;
  let added = 0;
  let removed = 0;
  for (const change of changes) {
    added += change.stats.added;
    removed += change.stats.removed;
  }
  return { ...changes[0]!.stats, added, removed };
}

function statsCarrier(changes: readonly FileChange[]): FileChange | undefined {
  const stats = totalStats(changes);
  return stats ? { ...changes[0]!, stats } : undefined;
}

export function diffTitleLine(
  ctx: BlockContext,
  item: ToolItem,
  change: FileChange | undefined,
): string {
  const presented = presentTool(item);
  const glyph = ctx.ink.fg(STATUS_TOKEN[item.status], toolGlyph(ctx, item.status));
  const title = ctx.ink.style(presented.name, { fg: "cyan", bold: true });
  const suffix = change && ctx.width + 2 >= SUFFIX_MIN_COLUMNS ? diffStatsSuffix(ctx, change) : "";
  return alignEnds(`${glyph} ${title}`, suffix, ctx.width, ctx.glyphs.ellipsis);
}

export function diffStatsRow(ctx: BlockContext, change: FileChange): string | undefined {
  if (ctx.width + 2 >= SUFFIX_MIN_COLUMNS) return undefined;
  return clipRow(ctx, `  ${diffStatsSuffix(ctx, change)}`);
}

function fileRow(ctx: BlockContext, change: FileChange): string {
  const { mark, token } = changeMark(ctx, change.kind);
  const path = ctx.ink.fg("inputBorder", relativeDisplayPath(change.path));
  return clipRow(ctx, ` ${ctx.ink.fg(token, mark)} ${path}`);
}

function labelRow(ctx: BlockContext, change: FileChange): string {
  return clipRow(ctx, `  ${ctx.ink.style(collapsedFileChangeLabel(change), { fg: "foreground", bold: true })}`);
}

function moreFilesRow(ctx: BlockContext, hidden: number): string {
  return clipRow(ctx, `  ${ctx.ink.fg("muted", `${ctx.glyphs.ellipsis} +${hidden} more file${hidden === 1 ? "" : "s"}`)}`);
}

export function buildDiffLines(ctx: BlockContext, item: ToolItem): string[] {
  const changes = item.fileChanges ?? [];
  const primary = changes[0];
  const multi = changes.length > 1;
  const diffExpanded = isFileDiffExpanded(ctx.state, item.id);
  const outputExpanded = isItemExpanded(ctx.state, item);
  const carrier = multi ? statsCarrier(changes) : primary;

  const lines = [diffTitleLine(ctx, item, carrier)];
  if (carrier) {
    const statsRow = diffStatsRow(ctx, carrier);
    if (statsRow) lines.push(statsRow);
  }

  const listed = multi ? changes.slice(0, WRITE_MANY_LISTED_FILES) : changes;
  const hiddenFiles = changes.length - listed.length;

  if (!diffExpanded) {
    if (primary && !multi) lines.push(labelRow(ctx, primary));
    if (multi) {
      for (const change of listed) lines.push(fileRow(ctx, change));
      if (hiddenFiles > 0) lines.push(moreFilesRow(ctx, hiddenFiles));
    }
    lines.push(...hintRows(ctx, "  ", outputToggleLabel(outputExpanded)));
    return lines;
  }

  const maxRows = multi ? WRITE_MANY_PREVIEW_ROWS : SINGLE_FILE_PREVIEW_ROWS;
  for (const change of listed) {
    if (multi) lines.push(fileRow(ctx, change));
    const rows = presentFileChangePreview(change, {
      maxLineChars: codeBudget(ctx, change),
      maxRows,
      tabWidth: DIFF_TAB_WIDTH,
    });
    for (const row of rows) lines.push(diffRowLine(ctx, row));
  }
  if (hiddenFiles > 0) lines.push(moreFilesRow(ctx, hiddenFiles));

  lines.push(...hintRows(ctx, "  ", outputToggleLabel(outputExpanded)));
  return lines;
}
