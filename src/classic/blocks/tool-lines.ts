import {
  isItemExpanded,
  type ToolItem,
  type ToolStatus,
} from "../../ui-core/state/transcript-types.js";
import { presentOutput, presentTool } from "../../ui-core/rendering/tool-presenter.js";
import { alignEnds, clipToWidth, trimTrailingSpaces } from "../render/ansi-text.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { adaptPresenterGlyphs } from "../render/glyphs.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { layoutWidth } from "../render/measure.js";
import {
  clipRow,
  formatElapsed,
  joinMeta,
  SUFFIX_MIN_COLUMNS,
  type BlockContext,
} from "./block-context.js";

/** Collapsed body rows (04-UI-SPEC §3.5). */
export const TOOL_COLLAPSED_BODY_ROWS = 3;
export const TOOL_EXPANDED_BODY_ROWS = 40;
/** Body rows kept while the tool is still open and clipped by the live tail. */
export const TOOL_LIVE_BODY_ROWS = 8;
const BODY_INDENT = 4;

const STATUS_TOKEN: Record<ToolStatus, ThemeToken> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "activity",
};

export function toolGlyph(ctx: BlockContext, status: ToolStatus): string {
  const glyphs = ctx.glyphs;
  switch (status) {
    case "queued":
      return glyphs.toolQueued;
    case "running":
      return glyphs.toolRunning;
    case "ok":
      return glyphs.toolOk;
    case "failed":
      return glyphs.toolFailed;
    default:
      return glyphs.toolBlocked;
  }
}

export function toolElapsed(ctx: BlockContext, item: ToolItem): string | undefined {
  if (item.status === "blocked") return undefined;
  const end = item.endedAt;
  const open = item.status === "running" || item.status === "queued";
  const span = open ? ctx.now - item.timestamp : end === undefined ? -1 : end - item.timestamp;
  const label = formatElapsed(span);
  return label === "" ? undefined : label;
}

/**
 * Right-aligned status suffix; dropped only on very narrow screens (<44 cols).
 * `statusLabel` already carries the non-zero exit code, so nothing is appended.
 */
export function toolSuffix(
  ctx: BlockContext,
  item: ToolItem,
  statusLabel: string,
): string {
  if (ctx.width + 2 < SUFFIX_MIN_COLUMNS) return "";
  const body = joinMeta(ctx, [statusLabel, toolElapsed(ctx, item)]);
  return body === "" ? "" : ctx.ink.fg(STATUS_TOKEN[item.status], body);
}

export function toolHeaderLines(ctx: BlockContext, item: ToolItem): string[] {
  const presented = presentTool(item);
  const glyph = ctx.ink.fg(STATUS_TOKEN[item.status], toolGlyph(ctx, item.status));
  const name = ctx.ink.style(presented.name, { fg: "cyan", bold: true });
  const head = `${glyph} ${name}`;
  const suffix = toolSuffix(ctx, item, presented.statusLabel);
  // Always keep args on the next line — never inline as shell.exec(input) — so
  // head + suffix stay on one line and (input) is indented below.
  if (suffix.length === 0) {
    const argsLines = (presented.argsDisplay ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (argsLines.length === 0) return [clipToWidth(head, ctx.width, ctx.glyphs.ellipsis)];
    const budget = Math.max(8, ctx.width - 2);
    const rows = argsLines.flatMap((l) => wrapAnsiLine(ctx.ink.fg("muted", `(${l})`), budget));
    return [clipToWidth(head, ctx.width, ctx.glyphs.ellipsis), ...rows.map((r) => trimTrailingSpaces(`  ${r}`))];
  }
  const suffixWidth = layoutWidth(suffix);
  // Suffix (done/running + timing) should sit just after head on the same line,
  // more left / closer to tool name, not flush-right at the far edge.
  const gap = "  ";
  const headBudget = Math.max(8, ctx.width - suffixWidth - layoutWidth(gap) - 1);
  const clippedHead = layoutWidth(head) > headBudget ? clipToWidth(head, headBudget, ctx.glyphs.ellipsis) : head;
  const argsLines = (presented.argsDisplay ?? "").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (argsLines.length === 0) {
    const first = `${clippedHead}${gap}${suffix}`;
    return [layoutWidth(first) > ctx.width ? clipToWidth(first, ctx.width, ctx.glyphs.ellipsis) : first];
  }
  const argsBudget = Math.max(8, ctx.width - 2);
  const argRows = argsLines.flatMap((l) => wrapAnsiLine(ctx.ink.fg("muted", `(${l})`), argsBudget));
  const first = `${clippedHead}${gap}${suffix}`;
  const clippedFirst = layoutWidth(first) > ctx.width ? clipToWidth(first, ctx.width, ctx.glyphs.ellipsis) : first;
  return [clippedFirst, ...argRows.map((r) => trimTrailingSpaces(`  ${r}`))];
}

export interface ToolBodyOptions {
  /** Hard cap on rendered body rows; the live tail passes a smaller number. */
  readonly maxRows?: number | undefined;
}

export function outputToggleLabel(expanded: boolean): string {
  return expanded ? "Ctrl+O to minimize" : "Ctrl+O to expand";
}

export function buildToolBodyLines(
  ctx: BlockContext,
  item: ToolItem,
  options: ToolBodyOptions = {},
): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const tail = ctx.spool.tail(item.toolCallId);
  const detail = item.status === "blocked" ? item.reason : item.summary;
  const source = tail.trim().length > 0 ? tail : (detail ?? "");
  const indent = " ".repeat(BODY_INDENT);
  if (source.trim().length === 0) {
    return [clipRow(ctx, `${indent}${ctx.ink.fg("muted", outputToggleLabel(expanded))}`)];
  }

  const presented = presentOutput(
    source,
    ctx.spool.state(item.toolCallId),
    expanded,
    item.name,
  );
  const cap =
    options.maxRows ??
    (expanded ? TOOL_EXPANDED_BODY_ROWS : TOOL_COLLAPSED_BODY_ROWS);
  const kept = presented.lines.slice(0, Math.max(0, cap));
  const hidden = presented.lines.length - kept.length + presented.hiddenAboveCount;

  const branch = ctx.ink.fg("muted", `  ${ctx.glyphs.bodyBranch} `);
  const budget = Math.max(1, ctx.width - BODY_INDENT);

  const lines: string[] = [];
  for (const [index, raw] of kept.entries()) {
    const text = adaptPresenterGlyphs(raw, ctx.ink.unicode);
    for (const [row, chunk] of wrapAnsiLine(text, budget).entries()) {
      const prefix = index === 0 && row === 0 ? branch : indent;
      lines.push(trimTrailingSpaces(`${prefix}${ctx.ink.fg("foreground", chunk)}`));
    }
  }

  const artifact = item.artifactPath ? "saved" : undefined;
  if (presented.truncatedNotice) {
    lines.push(
      clipRow(ctx, `${indent}${ctx.ink.fg("muted", presented.truncatedNotice)}`),
    );
  }
  const body = joinMeta(ctx, [
    outputToggleLabel(expanded),
    hidden > 0
      ? `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`
      : undefined,
    artifact,
  ]);
  lines.push(clipRow(ctx, `${indent}${ctx.ink.fg("muted", body)}`));
  return lines;
}

export function buildToolLines(
  ctx: BlockContext,
  item: ToolItem,
  options: ToolBodyOptions = {},
): string[] {
  return [
    ...toolHeaderLines(ctx, item),
    ...buildToolBodyLines(ctx, item, options),
  ];
}
