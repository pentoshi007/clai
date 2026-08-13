import type { FileChange } from "../../tools/file-diff.js";
import {
  collapsedFileChangeLabel,
  presentFileChangePreview,
  syntaxColor,
  type PresentedDiffRow,
} from "../../ui-core/rendering/file-diff-view.js";
import { presentTool } from "../../ui-core/rendering/tool-presenter.js";
import {
  isFileDiffExpanded,
  isItemExpanded,
  type ToolItem,
} from "../../ui-core/state/transcript-types.js";
import { alignEnds, padStartToWidth, padToWidth, sealStyle, trimTrailingSpaces } from "../render/ansi-text.js";
import type { TextStyle, ThemeToken } from "../render/ink-theme.js";
import { clipRow, joinMeta, SUFFIX_MIN_COLUMNS, type BlockContext } from "./block-context.js";
import { outputToggleLabel, toolGlyph } from "./tool-lines.js";

/** Preview caps already defined by the OpenTUI diff card; reused verbatim. */
export const SINGLE_FILE_PREVIEW_ROWS = 40;
export const WRITE_MANY_PREVIEW_ROWS = 8;
const GUTTER_WIDTH = 4;
/** `gutter(4) + space + marker + two spaces`. */
export const DIFF_CODE_COLUMN = GUTTER_WIDTH + 4;

const STATUS_TOKEN: Record<ToolItem["status"], ThemeToken> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "activity",
};

/** The wash is dropped at 16 colours and none; the marker column carries the state. */
function washOk(ctx: BlockContext): boolean {
  return ctx.ink.colorMode === "truecolor" || ctx.ink.colorMode === "256";
}

function rowStyle(ctx: BlockContext, tone: PresentedDiffRow["tone"]): TextStyle {
  if (tone === "add") return { fg: "diffAdd", bg: washOk(ctx) ? "diffAddBg" : undefined };
  if (tone === "del") return { fg: "diffDel", bg: washOk(ctx) ? "diffDelBg" : undefined };
  if (tone === "gap") return { fg: "muted" };
  if (tone === "header") return { fg: "muted", bold: true };
  return {};
}

function codeText(ctx: BlockContext, row: PresentedDiffRow, budget: number): string {
  const wash = washOk(ctx) && (row.tone === "add" || row.tone === "del");
  const body = wash ? padToWidth(row.displayText, budget) : row.displayText;
  if (row.tone !== "context") return ctx.ink.style(body, rowStyle(ctx, row.tone));
  if (ctx.ink.colorMode === "none") return body;
  let out = "";
  for (const span of row.spans) out += ctx.ink.hex(syntaxColor(span.kind, ctx.ink.theme), span.text);
  return out;
}

export function diffStatsSuffix(ctx: BlockContext, change: FileChange): string {
  const minus = ctx.ink.unicode ? "−" : "-";
  return `${ctx.ink.fg("diffAdd", `+${change.stats.added}`)} ${ctx.ink.fg("diffDel", `${minus}${change.stats.removed}`)}`;
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

/** Below 68 columns the +N/−N counters move to their own row. */
export function diffStatsRow(ctx: BlockContext, change: FileChange): string | undefined {
  if (ctx.width + 2 >= SUFFIX_MIN_COLUMNS) return undefined;
  return clipRow(ctx, `  ${diffStatsSuffix(ctx, change)}`);
}

function diffRowLine(ctx: BlockContext, row: PresentedDiffRow): string {
  const marker = row.prefix === "−" && !ctx.ink.unicode ? "-" : row.prefix;
  const gutter = ctx.ink.fg("diffGutter", padStartToWidth(row.gutter, GUTTER_WIDTH));
  const budget = Math.max(1, ctx.width - DIFF_CODE_COLUMN);
  const head = `${gutter} ${ctx.ink.style(marker, rowStyle(ctx, row.tone))}  `;
  return trimTrailingSpaces(sealStyle(`${head}${codeText(ctx, row, budget)}`));
}

export function buildDiffLines(ctx: BlockContext, item: ToolItem): string[] {
  const changes = item.fileChanges ?? [];
  const primary = changes[0];
  const diffExpanded = isFileDiffExpanded(ctx.state, item.id);
  const outputExpanded = isItemExpanded(ctx.state, item);

  const lines = [diffTitleLine(ctx, item, primary)];
  if (primary) {
    const statsRow = diffStatsRow(ctx, primary);
    if (statsRow) lines.push(statsRow);
  }

  if (!diffExpanded) {
    if (primary) {
      lines.push(clipRow(ctx, `  ${ctx.ink.fg("muted", collapsedFileChangeLabel(primary))}`));
    }
    lines.push(clipRow(ctx, `  ${ctx.ink.fg("muted", outputToggleLabel(outputExpanded))}`));
    return lines;
  }

  const maxRows = changes.length > 1 ? WRITE_MANY_PREVIEW_ROWS : SINGLE_FILE_PREVIEW_ROWS;
  const maxLineChars = Math.max(16, ctx.width - DIFF_CODE_COLUMN);
  let emitted = 0;

  for (const change of changes) {
    if (emitted >= maxRows) break;
    if (changes.length > 1) {
      lines.push(
        clipRow(ctx, `  ${ctx.ink.fg("cyan", change.path)} ${diffStatsSuffix(ctx, change)}`),
      );
    }
    for (const row of presentFileChangePreview(change, { maxLineChars, maxRows })) {
      if (emitted >= maxRows) break;
      lines.push(diffRowLine(ctx, row));
      emitted += 1;
    }
  }

  const total = changes.reduce((sum, c) => sum + c.stats.added + c.stats.removed, 0);
  const hidden = Math.max(0, total - emitted);
  const body = joinMeta(ctx, [
    outputToggleLabel(outputExpanded),
    hidden > 0
      ? `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`
      : undefined,
  ]);
  lines.push(clipRow(ctx, `  ${ctx.ink.fg("muted", body)}`));
  return lines;
}
