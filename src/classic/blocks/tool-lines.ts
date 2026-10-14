import {
  isItemExpanded,
  type ToolItem,
  type ToolStatus,
} from "../../ui-core/state/transcript-types.js";
import {
  presentFsReadArgs,
  presentOutput,
  presentTool,
  toolStatusText,
  TOOL_PREVIEW_HEAD_LINES,
  TOOL_PREVIEW_TAIL_LINES,
} from "../../ui-core/rendering/tool-presenter.js";
import { shouldShowToolElapsed } from "../../ui-core/rendering/duration.js";
import { clipToWidth, trimTrailingSpaces } from "../render/ansi-text.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { adaptPresenterGlyphs } from "../render/glyphs.js";
import { wrapAnsiLine, wrapAnsiLineBounded } from "../render/wrap.js";
import { restoredTerminalArgs } from "../../agent/parser/terminal-args.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { parseFsReadSections } from "../../tools/fs/read-sections.js";
import { layoutWidth } from "../render/measure.js";
import {
  clipRow,
  COLLAPSED_LINE_ROWS,
  EXPANDED_LINE_ROWS,
  formatElapsed,
  joinMeta,
  separator,
  wrapBoundedRows,
  type BlockContext,
} from "./block-context.js";

export const TOOL_COLLAPSED_BODY_ROWS =
  TOOL_PREVIEW_HEAD_LINES + TOOL_PREVIEW_TAIL_LINES + 1;
export const TOOL_EXPANDED_BODY_ROWS = 40;
export const TOOL_LIVE_BODY_ROWS = 8;
export const TOOL_INPUT_PREVIEW_ROWS = 2;
const BODY_INDENT = 4;
const FIELD_INDENT = "  ";
const SUMMARY_TOOLS: ReadonlySet<string> = new Set(["fs.read"]);

export const TOOL_STATUS_TOKEN: Readonly<Record<ToolStatus, ThemeToken>> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "diffDel",
};

const META_TOKEN: Record<ToolStatus, ThemeToken> = {
  queued: "muted",
  running: "activity",
  ok: "hint",
  failed: "diffDel",
  blocked: "diffDel",
};

type Presented = ReturnType<typeof presentTool>;

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
  if (item.status === "blocked" || !shouldShowToolElapsed(item.name)) return undefined;
  const end = item.endedAt;
  const open = item.status === "running" || item.status === "queued";
  const span = open ? ctx.now - item.timestamp : end === undefined ? -1 : end - item.timestamp;
  const label = formatElapsed(span);
  return label === "" ? undefined : label;
}

export function toolSuffix(
  ctx: BlockContext,
  item: ToolItem,
  statusLabel: string,
): string {
  const label = item.status === "ok" ? undefined : toolStatusText(statusLabel);
  const body = joinMeta(ctx, [label, toolElapsed(ctx, item)]);
  return body === "" ? "" : ctx.ink.fg(META_TOKEN[item.status], body);
}

export function hintRows(ctx: BlockContext, indent: string, text: string): string[] {
  const budget = Math.max(1, ctx.width - layoutWidth(indent));
  return wrapAnsiLine(text, budget).map((row) => clipRow(ctx, `${indent}${ctx.ink.fg("hint", row)}`));
}

function argLines(item: ToolItem, presented: Presented, expanded: boolean): string[] {
  if (presented.argsDisplay === undefined) return [];
  const raw = sanitizeDisplayText(restoredTerminalArgs(item.name, item.argsDisplay));
  if (!raw.trim()) return [];
  const lines = raw.split("\n");
  return expanded ? lines : lines.map((line) => line.trim()).filter((line) => line.length > 0);
}

function inputPreviewRows(ctx: BlockContext, rows: string[], expanded: boolean): string[] {
  if (expanded || rows.length <= TOOL_INPUT_PREVIEW_ROWS) return rows;
  const kept = rows.slice(0, TOOL_INPUT_PREVIEW_ROWS);
  const marker = ctx.ink.fg("hint", ` ${ctx.glyphs.ellipsis}`);
  const last = kept.length - 1;
  const budget = Math.max(0, ctx.width - layoutWidth(marker));
  kept[last] = clipRow(ctx, `${clipToWidth(kept[last]!, budget, "")}${marker}`);
  return kept;
}

function toolTitle(ctx: BlockContext, item: ToolItem, presented: Presented): string {
  const token = TOOL_STATUS_TOKEN[item.status];
  const glyph = ctx.ink.fg(token, toolGlyph(ctx, item.status));
  return `${glyph} ${ctx.ink.style(presented.name, { fg: token, bold: true })}`;
}

function metaSuffix(ctx: BlockContext, item: ToolItem, presented: Presented): string {
  const suffix = toolSuffix(ctx, item, presented.statusLabel);
  return suffix === "" ? "" : `${ctx.ink.fg("hint", separator(ctx))}${suffix}`;
}

function headline(ctx: BlockContext, item: ToolItem, presented: Presented, inline: string | undefined): string[] {
  const title = toolTitle(ctx, item, presented);
  const args = inline === undefined ? "" : ` ${ctx.ink.fg("inputBorder", `(${inline})`)}`;
  const meta = metaSuffix(ctx, item, presented);
  const line = `${title}${args}${meta}`;
  if (layoutWidth(line) <= ctx.width) return [line];
  const head = clipToWidth(`${title}${args}`, ctx.width, ctx.glyphs.ellipsis);
  const suffix = toolSuffix(ctx, item, presented.statusLabel);
  if (suffix === "") return [head];
  const budget = Math.max(1, ctx.width - FIELD_INDENT.length);
  return [head, ...wrapAnsiLine(suffix, budget).map((row) => clipRow(ctx, `${FIELD_INDENT}${row}`))];
}

function inlineFits(ctx: BlockContext, item: ToolItem, presented: Presented, args: string): boolean {
  const used = layoutWidth(toolTitle(ctx, item, presented)) + layoutWidth(args) + 3;
  return used + layoutWidth(metaSuffix(ctx, item, presented)) <= ctx.width;
}

function fieldLines(ctx: BlockContext, label: string, value: string, token: ThemeToken, expanded: boolean): string[] {
  const prefix = `${FIELD_INDENT}${ctx.ink.fg("muted", `${label}: `)}`;
  const budget = Math.max(1, ctx.width - layoutWidth(prefix));
  const maxRows = expanded ? Number.POSITIVE_INFINITY : TOOL_INPUT_PREVIEW_ROWS + 1;
  const { rows } = wrapAnsiLineBounded(ctx.ink.fg(token, value), budget, maxRows);
  return rows.map((row, index) =>
    clipRow(ctx, index === 0 ? `${prefix}${row}` : `${" ".repeat(layoutWidth(prefix))}${row}`),
  );
}

function fsReadHeaderLines(ctx: BlockContext, item: ToolItem, presented: Presented): string[] {
  const args = presentFsReadArgs(item.argsDisplay);
  const lines = headline(ctx, item, presented, undefined);
  const input: string[] = [];
  const files = args.files ?? [args];
  const sections = args.files ? parseFsReadSections(ctx.spool.tail(item.toolCallId)) : [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    const section = sections.find((entry) => entry.index === index + 1);
    const glyph = section ? `${section.ok ? ctx.glyphs.toolOk : ctx.glyphs.toolFailed} ` : "";
    const label = args.files ? `file ${index + 1}/${files.length}` : "file";
    if (file.options) input.push(...fieldLines(ctx, "options", file.options, "inputBorder", true));
    if (file.path) input.push(...fieldLines(ctx, label, `${glyph}${file.path}`, section?.ok === false ? "diffDel" : "inputBorder", true));
  }
  return [...lines, ...input];
}

export function toolHeaderLines(ctx: BlockContext, item: ToolItem): string[] {
  const presented = presentTool(item);
  if (item.name === "fs.read") return fsReadHeaderLines(ctx, item, presented);
  const expanded = isItemExpanded(ctx.state, item);
  const args = argLines(item, presented, expanded);
  if (args.length === 1 && inlineFits(ctx, item, presented, args[0]!)) {
    return headline(ctx, item, presented, args[0]);
  }
  const head = headline(ctx, item, presented, undefined);
  if (args.length === 0) return head;
  const budget = Math.max(1, ctx.width - FIELD_INDENT.length);
  const rows: string[] = [];
  for (const line of args) {
    const maxRows = expanded ? Number.POSITIVE_INFINITY : TOOL_INPUT_PREVIEW_ROWS + 1 - rows.length;
    const wrapped = wrapAnsiLineBounded(ctx.ink.fg("inputBorder", `(${line})`), budget, maxRows);
    for (const row of wrapped.rows) rows.push(clipRow(ctx, `${FIELD_INDENT}${row}`));
    if (!expanded && rows.length > TOOL_INPUT_PREVIEW_ROWS) break;
  }
  return [...head, ...inputPreviewRows(ctx, rows, expanded)];
}

export interface ToolBodyOptions {
  readonly maxRows?: number | undefined;
}

export function outputToggleLabel(expanded: boolean): string {
  return expanded ? "Ctrl+O to minimize" : "Ctrl+O to expand";
}

function bodySource(ctx: BlockContext, item: ToolItem): string {
  const tail = ctx.spool.tail(item.toolCallId);
  const detail = item.status === "blocked" ? item.reason : item.summary;
  return tail.trim().length > 0 ? tail : (detail ?? "");
}

export function buildToolBodyLines(
  ctx: BlockContext,
  item: ToolItem,
  options: ToolBodyOptions = {},
): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const indent = " ".repeat(BODY_INDENT);
  const failed = item.status === "failed" || item.status === "blocked";
  if (SUMMARY_TOOLS.has(item.name) && !expanded && !failed) {
    return hintRows(ctx, FIELD_INDENT, outputToggleLabel(false));
  }
  const source = bodySource(ctx, item);
  if (source.trim().length === 0) {
    return hintRows(ctx, indent, outputToggleLabel(expanded));
  }

  const presented = presentOutput(
    source,
    ctx.spool.state(item.toolCallId),
    expanded,
    item.name,
  );
  const collapsedRows = item.name.startsWith("terminal.") ? 12 : TOOL_COLLAPSED_BODY_ROWS;
  const cap = options.maxRows ?? (expanded ? TOOL_EXPANDED_BODY_ROWS : collapsedRows);
  const kept = presented.lines.slice(0, Math.max(0, cap));
  const hidden = presented.lines.length - kept.length;

  const budget = Math.max(1, ctx.width - BODY_INDENT);
  const lineRows = expanded ? EXPANDED_LINE_ROWS : COLLAPSED_LINE_ROWS;

  const lines: string[] = [];
  for (const [index, raw] of kept.entries()) {
    const gap = raw.startsWith("…") || raw.startsWith("···");
    const token = gap ? "muted" : "toolOutput";
    const painted = ctx.ink.style(adaptPresenterGlyphs(raw, ctx.ink.unicode), { fg: token, dim: gap });
    for (const [row, chunk] of wrapBoundedRows(ctx, painted, budget, lineRows).entries()) {
      const prefix = index === 0 && row === 0 ? ctx.ink.fg(token, `  ${ctx.glyphs.bodyBranch} `) : indent;
      lines.push(trimTrailingSpaces(`${prefix}${chunk}`));
    }
  }

  if (presented.truncatedNotice) {
    lines.push(...hintRows(ctx, indent, presented.truncatedNotice));
  }
  const body = joinMeta(ctx, [
    hidden > 0
      ? `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`
      : undefined,
    outputToggleLabel(expanded),
    item.artifactPath ? "saved" : undefined,
  ]);
  lines.push(...hintRows(ctx, indent, body));
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
