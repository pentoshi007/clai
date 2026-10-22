import { isItemExpanded, type ToolItem, type ToolStatus } from "../../ui-core/state/transcript-types.js";
import { presentFsReadArgs, presentTool, toolStatusText } from "../../ui-core/rendering/tool-presenter.js";
import { shouldShowToolElapsed } from "../../ui-core/rendering/duration.js";
import { restoredTerminalArgs } from "../../agent/parser/terminal-args.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { parseFsReadSections } from "../../tools/fs/read-sections.js";
import { clipToWidth } from "../render/ansi-text.js";
import type { ThemeToken } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { wrapAnsiLine } from "../render/wrap.js";
import { clipRow, formatElapsed, joinMeta, separator, type BlockContext } from "./block-context.js";
import { appendDisclosure } from "./disclosure-lines.js";
import { classicToolLabel } from "./tool-label.js";
import { logicalOutputLines, outputBodyRows, OUTPUT_PREVIEW_LINES, PREVIEW_LINE_CHARS } from "./output-lines.js";

export const TOOL_STATUS_TOKEN: Readonly<Record<ToolStatus, ThemeToken>> = {
  queued: "muted",
  running: "activity",
  ok: "success",
  failed: "diffDel",
  blocked: "diffDel",
};

export function toolGlyph(ctx: BlockContext, status: ToolStatus): string {
  if (status === "queued") return ctx.glyphs.toolQueued;
  if (status === "blocked") return ctx.glyphs.toolBlocked;
  return ctx.ink.unicode ? "•" : "*";
}

export function toolElapsed(ctx: BlockContext, item: ToolItem): string | undefined {
  if (item.status === "blocked" || !shouldShowToolElapsed(item.name)) return undefined;
  const open = item.status === "running" || item.status === "queued";
  const span = open ? ctx.now - item.timestamp : item.endedAt === undefined ? -1 : item.endedAt - item.timestamp;
  const label = formatElapsed(span);
  return label || undefined;
}

export function toolSuffix(ctx: BlockContext, item: ToolItem, statusLabel: string): string {
  const label = item.status === "ok" ? undefined : toolStatusText(statusLabel);
  const token = item.status === "failed" || item.status === "blocked" ? "diffDel" : "hint";
  const elapsed = toolElapsed(ctx, item);
  return joinMeta(ctx, [label ? ctx.ink.fg(token, label) : undefined, elapsed ? ctx.ink.fg(TOOL_STATUS_TOKEN[item.status], elapsed) : undefined]);
}

export function hintRows(ctx: BlockContext, indent: string, text: string): string[] {
  return wrapAnsiLine(text, Math.max(1, ctx.width - layoutWidth(indent)))
    .map((row) => clipRow(ctx, `${indent}${ctx.ink.fg("hint", row)}`));
}

function inputSource(item: ToolItem): string {
  return sanitizeDisplayText(restoredTerminalArgs(item.name, item.argsDisplay)).replace(/\s+$/, "");
}

function headline(ctx: BlockContext, item: ToolItem, input = ""): string {
  const token = TOOL_STATUS_TOKEN[item.status];
  const title = `${ctx.ink.fg(token, toolGlyph(ctx, item.status))} ${ctx.ink.style(classicToolLabel(item), { fg: token, bold: true })}`;
  const suffix = toolSuffix(ctx, item, presentTool(item).statusLabel);
  const meta = suffix ? `${ctx.ink.fg("hint", separator(ctx))}${suffix}` : "";
  const budget = Math.max(1, ctx.width - layoutWidth(meta));
  const args = input ? ` ${ctx.ink.fg("inputBorder", input)}` : "";
  const head = clipToWidth(`${title}${args}`, budget, ctx.glyphs.ellipsis);
  return clipRow(ctx, `${head}${meta}`);
}

function readHeaderLines(ctx: BlockContext, item: ToolItem, expanded: boolean): string[] {
  const parsed = presentFsReadArgs(item.argsDisplay);
  const files = parsed.files ?? [parsed];
  const sections = parseFsReadSections(ctx.spool.tail(item.toolCallId));
  const lines = [headline(ctx, item)];
  for (const [index, file] of files.entries()) {
    if (!file.path) continue;
    const section = sections.find((entry) => entry.index === index + 1);
    const token = section?.ok === false ? "diffDel" : "inputBorder";
    const body = `${ctx.ink.fg("toolOutput", "Read")} ${ctx.ink.fg(token, file.path)}`;
    const prefix = index === 0 ? `  ${ctx.glyphs.bodyBranch} ` : "    ";
    const width = Math.max(1, ctx.width - 4);
    const rows = expanded ? wrapAnsiLine(body, width) : [clipToWidth(body, width, ctx.glyphs.ellipsis)];
    for (const [row, chunk] of rows.entries()) lines.push(clipRow(ctx, `${row === 0 ? prefix : "    "}${chunk}`));
  }
  if (expanded && item.argsDisplay.trim()) {
    lines.push(...hintRows(ctx, "    ", "Input"));
    lines.push(...outputBodyRows(ctx, logicalOutputLines(inputSource(item)), true, { token: "inputBorder", branch: false }));
  }
  return lines;
}

export function toolHeaderLines(ctx: BlockContext, item: ToolItem): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  if (item.name === "fs.read") return readHeaderLines(ctx, item, expanded);
  const input = inputSource(item);
  const first = input.split("\n", 1)[0]?.trim() ?? "";
  const multiline = input.includes("\n");
  const preview = first.slice(0, PREVIEW_LINE_CHARS);
  const clipped = multiline || preview !== first ? `${preview} ${ctx.glyphs.ellipsis}` : preview;
  const lines = [headline(ctx, item, clipped)];
  const inputBudget = Math.max(0, ctx.width - layoutWidth(headline(ctx, item)) - 1);
  if (expanded && input && (multiline || layoutWidth(first) > inputBudget)) {
    lines.push(...hintRows(ctx, "    ", "Input"));
    lines.push(...outputBodyRows(ctx, logicalOutputLines(input), true, { token: "inputBorder", branch: false }));
  }
  return lines;
}

export interface ToolBodyOptions {
  readonly maxRows?: number;
}

function bodySource(ctx: BlockContext, item: ToolItem): string {
  const output = ctx.spool.tail(item.toolCallId);
  return output.trim() ? output : (item.status === "blocked" ? item.reason : item.summary) ?? "";
}

export function buildToolBodyLines(ctx: BlockContext, item: ToolItem, options: ToolBodyOptions = {}): string[] {
  const expanded = isItemExpanded(ctx.state, item);
  const failed = item.status === "failed" || item.status === "blocked";
  const source = logicalOutputLines(bodySource(ctx, item), item.name);
  const hiddenRead = item.name === "fs.read" && !expanded && !failed;
  const lines = hiddenRead ? [] : outputBodyRows(ctx, source, expanded, { maxLines: options.maxRows ?? OUTPUT_PREVIEW_LINES });
  const spoolState = ctx.spool.state(item.toolCallId);
  const notice = ctx.spool.notice?.(item.toolCallId);
  if (expanded && notice) lines.push(...hintRows(ctx, "    ", notice));
  if (expanded && spoolState?.truncated && !notice) lines.push(...hintRows(ctx, "    ", "Earlier output is saved in the artifact"));
  if (expanded && (notice?.startsWith("Large output") || spoolState?.truncated && !notice) && item.artifactPath) {
    appendDisclosure(ctx, lines, true, { label: "+ full output", chord: "/output", action: "output" });
  }
  if (source.length === 0 && !hiddenRead) {
    const open = item.status === "queued" || item.status === "running";
    lines.push(...outputBodyRows(ctx, [open ? "waiting for output" : "(no output)"], false, { token: "hint" }));
  }
  appendDisclosure(ctx, lines, expanded, { hidden: hiddenRead || spoolState?.truncated ? 0 : Math.max(0, source.length - (options.maxRows ?? OUTPUT_PREVIEW_LINES)) });
  return lines;
}

export function buildToolLines(ctx: BlockContext, item: ToolItem, options: ToolBodyOptions = {}): string[] {
  const header = toolHeaderLines(ctx, item);
  return [...header, ...buildToolBodyLines({ ...ctx, lineOffset: header.length }, item, options)];
}
