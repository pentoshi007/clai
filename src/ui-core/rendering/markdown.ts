import chalk, { Chalk, type ChalkInstance } from "chalk";
import type { ColorMode } from "../../app/ports/terminal-port.js";
import {
  codeBlockBottom,
  codeBlockFitWidth,
  codeBlockRows,
  codeBlockTop,
  codeBlockWidth,
  isCodeFenceClose,
  matchCodeFenceOpen,
  openCodeFence,
  trimCodeBlockBody,
  type CodeBlockAppearance,
  type CodeFenceState,
} from "./code-block.js";
import { renderInlineMarkdown, renderTableBlock } from "./markdown/tables.js";
import { matchTableHeader, parseTableRow, type TableHeader } from "./markdown/table-syntax.js";
import { splitMarkdownBreaks } from "./markdown/markup.js";
import { splitBoldLines } from "./markdown/bold-lines.js";

import { terminalWidth } from "./text-width.js";
import { wrapPagerLine } from "./pager-chrome.js";
import { paintLineChangeCounts } from "./line-change-labels.js";
import { diffMarkdownRows, emptyDiffRowState } from "./markdown-diff-rows.js";
import { detectThemeHint } from "../bootstrap/capabilities.js";
import { themeFor } from "./theme.js";
export { renderInlineMarkdown };
export { terminalWidth as visibleWidth } from "./text-width.js";

export const CHALK_LEVEL: Record<ColorMode, 0 | 1 | 2 | 3> = {
  none: 0,
  "16": 1,
  "256": 2,
  truecolor: 3,
};

export type MarkdownAppearance = CodeBlockAppearance & {
  readonly isolateBold?: boolean | undefined;
  readonly quotePrefix?: string | undefined;
  readonly literalQuotes?: boolean | undefined;
  readonly lineChangeColors?: boolean | undefined;
  readonly diffLines?: boolean | undefined;
};

interface RenderContext {
  readonly appearance: MarkdownAppearance | undefined;
  readonly paint: ChalkInstance;
}

function renderContext(appearance?: MarkdownAppearance): RenderContext {
  return {
    appearance,
    paint:
      appearance?.colorMode === undefined
        ? chalk
        : new Chalk({ level: CHALK_LEVEL[appearance.colorMode] }),
  };
}

function paintChangeCounts(text: string, context: RenderContext): string {
  if (!context.appearance?.lineChangeColors) return text;
  const { theme } = context.appearance;
  return paintLineChangeCounts(text,
    (value) => theme ? context.paint.hex(theme.success)(value) : context.paint.green(value),
    (value) => theme ? context.paint.hex(theme.diffDel)(value) : context.paint.red(value),
  );
}

interface BlockState {
  inFence: boolean;
  fenceWidth?: number;
  fence?: CodeFenceState | undefined;
}

const DEFAULT_FENCE_WIDTH = 60;

function panelWidth(state: BlockState): number {
  return codeBlockWidth(state.fenceWidth ?? DEFAULT_FENCE_WIDTH);
}

function openFencePanel(
  state: BlockState,
  marker: string,
  info: string,
  context: RenderContext,
): string {
  state.inFence = true;
  state.fence = openCodeFence(marker, info);
  return codeBlockTop(
    state.fence.label,
    panelWidth(state),
    context.appearance,
  );
}

function closeFencePanel(state: BlockState, context: RenderContext): string {
  state.inFence = false;
  state.fence = undefined;
  return codeBlockBottom(panelWidth(state), context.appearance);
}

function renderCodeBlock(
  open: { marker: string; info: string },
  bodyLines: readonly string[],
  wrapWidth: number,
  context: RenderContext,
): string[] {
  const fence = openCodeFence(open.marker, open.info);
  const body = trimCodeBlockBody(bodyLines);
  const width = codeBlockFitWidth(body, fence.label, wrapWidth, context.appearance);
  const out = [codeBlockTop(fence.label, width, context.appearance)];
  for (const line of body) {
    out.push(...codeBlockRows(line, fence, width, context.appearance));
  }
  out.push(codeBlockBottom(width, context.appearance));
  return out;
}

function fencePanelRows(
  line: string,
  state: BlockState,
  context: RenderContext,
): string[] | undefined {
  if (state.inFence && state.fence) {
    if (isCodeFenceClose(line, state.fence.marker)) {
      return [closeFencePanel(state, context)];
    }
    return codeBlockRows(
      line,
      state.fence,
      panelWidth(state),
      context.appearance,
    );
  }
  const open = matchCodeFenceOpen(line);
  if (!open) return undefined;
  return [openFencePanel(state, open.marker, open.info, context)];
}

const OUTPUT_INDENT = "  ";
const THEMATIC_BREAK = /^[ \t]*(?:-(?:[ \t]*-){2,}|\*(?:[ \t]*\*){2,}|_(?:[ \t]*_){2,})[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?(.*)$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;

export function indentAndWrapText(text: string, indent = "  "): string {
  if (!text) return text;
  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);
  return text
    .split("\n")
    .map((line) => {
      const wrapped = wrapAnsiLine(line, wrapWidth);
      return wrapped.map((wl) => `${indent}${wl}`).join("\n");
    })
    .join("\n");
}

function markdownSegments(text: string, context: RenderContext): string[] {
  return context.appearance?.isolateBold ? splitBoldLines(text) : [text];
}

function wrapInlineMarkdown(
  text: string,
  width: number,
  context: RenderContext,
  dim = false,
): string[] {
  return splitMarkdownBreaks(text, "\n").flatMap((line) => markdownSegments(line, context).flatMap((segment) => {
    const rendered = renderInlineMarkdown(segment, context.paint);
    return wrapAnsiLine(dim ? context.paint.dim(rendered) : rendered, width);
  }));
}

function wrapMarkdownLine(
  line: string,
  wrapWidth: number,
  context: RenderContext,
): string[] {
  const { paint } = context;
  if (THEMATIC_BREAK.test(line)) {
    return [paint.dim("─".repeat(Math.min(60, wrapWidth)))];
  }

  const quote = QUOTE.exec(line);
  if (quote) {
    const content = quote[1]!;
    const prefix = paint.dim(context.appearance?.quotePrefix ?? "│ ");
    const width = Math.max(2, wrapWidth - terminalWidth(prefix));
    if (context.appearance?.literalQuotes) {
      const rows = context.appearance.lineChangeColors
        ? wrapAnsiLine(paintChangeCounts(content, context), width)
        : wrapPagerLine(content, width, { preserveWhitespace: true });
      return rows.map((row) => prefix + paint.dim(row));
    }
    return wrapInlineMarkdown(content, width, context).map((row) => prefix + paint.dim.italic(row));
  }

  const list = LIST_ITEM.exec(line);
  if (list) {
    const marker = list[2]!;
    const task = marker.length === 1 ? /^\[([ xX])\](?:[ \t]+(.*)|$)/.exec(list[3]!) : null;
    const checked = task?.[1]?.toLowerCase() === "x";
    const bullet = task
      ? (checked ? paint.green("☑") : paint.dim("☐"))
      : paint.cyan(marker.length === 1 ? "•" : marker);
    const indent = list[1]!.replaceAll("\t", "    ").slice(0, Math.max(0, wrapWidth - marker.length - 3));
    const prefix = `${indent}${bullet} `;
    const prefixLength = terminalWidth(prefix);
    const content = task ? task[2] ?? "" : list[3]!;
    const rows = wrapInlineMarkdown(content, Math.max(2, wrapWidth - prefixLength), context, checked);
    return rows.map((row, index) => (index === 0 ? prefix : " ".repeat(prefixLength)) + row);
  }

  const pieces = splitMarkdownBreaks(line);
  if (pieces.length > 1) {
    return pieces.flatMap((part) => wrapMarkdownLine(part, wrapWidth, context));
  }
  const text = pieces[0]!;
  const heading = /^(?: {0,3})(#{1,6})(?:[ \t]+(.*)|$)/.exec(text);
  if (heading) {
    const level = heading[1]!.length;
    const body = (heading[2] ?? "").replace(/(?:^|[ \t]+)#+[ \t]*$/, "").trim();
    const style = level <= 2 ? paint.bold.magenta : level === 3 ? paint.bold.cyan : paint.bold;
    return wrapAnsiLine(paintChangeCounts(style(renderInlineMarkdown(body, paint)), context), wrapWidth);
  }

  return markdownSegments(text, context).flatMap((segment) =>
    wrapAnsiLine(paintChangeCounts(renderInlineMarkdown(segment, paint), context), wrapWidth),
  );
}

export function renderMarkdown(
  text: string,
  width?: number,
  appearance?: MarkdownAppearance,
): string {
  if (!text) return text;
  const context = renderContext(appearance);
  const lines = text.split(/\r?\n/);
  const resultLines: string[] = [];

  const hasWidth = typeof width === "number";
  const cols = width ?? (process.stdout.columns || 80);
  const wrapWidth = hasWidth ? Math.max(12, cols - 2) : Math.max(40, cols - 6);
  const diffState = appearance?.diffLines ? emptyDiffRowState() : undefined;
  const diffTheme = diffState ? appearance?.theme ?? themeFor(detectThemeHint(process.env)) : undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    const diffRows = diffState && diffTheme ? diffMarkdownRows(line, wrapWidth, diffState, context.paint, diffTheme) : undefined;
    if (diffRows) {
      for (const row of diffRows) resultLines.push(`${OUTPUT_INDENT}${row}`);
      i++;
      continue;
    }

    const fenceOpen = matchCodeFenceOpen(line);
    if (fenceOpen) {
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && !isCodeFenceClose(lines[j]!, fenceOpen.marker)) {
        body.push(lines[j]!);
        j += 1;
      }
      for (const rendered of renderCodeBlock(fenceOpen, body, wrapWidth, context)) {
        resultLines.push(`${OUTPUT_INDENT}${rendered}`);
      }
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    const separator = lines[i + 1];
    const table = separator?.includes("-") ? matchTableHeader(parseTableRow(line), separator) : undefined;
    if (table) {
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j += 1) {
        const row = parseTableRow(lines[j]!);
        if (!row) break;
        rows.push(row);
      }
      for (const rendered of renderTableBlock(table, rows, wrapWidth, context.paint, wrapAnsiLine)) {
        resultLines.push(`${OUTPUT_INDENT}${rendered}`);
      }
      i = j;
      continue;
    }

    for (const rendered of wrapMarkdownLine(line, wrapWidth, context)) {
      resultLines.push(`${OUTPUT_INDENT}${rendered}`);
    }
    i++;
  }

  return resultLines.join("\n");
}

export function createMarkdownStreamWriter(
  write: (chunk: string) => void,
  appearance?: MarkdownAppearance,
): {
  push(token: string): void;
  finish(): void;
} {
  const context = renderContext(appearance);
  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);
  const state: BlockState = { inFence: false, fenceWidth: wrapWidth };
  let buffer = "";
  let outputEndsWithNewline = true;
  let pendingHeader: { line: string; cells: string[]; withNewline: boolean } | undefined;
  let table: { header: TableHeader; rows: string[][]; withNewline: boolean } | undefined;

  const emit = (chunk: string): void => {
    if (!chunk) return;
    write(chunk);
    outputEndsWithNewline = chunk.endsWith("\n");
  };

  const emitRows = (rows: readonly string[], withNewline: boolean): void => {
    for (const [index, row] of rows.entries()) {
      emit(`${OUTPUT_INDENT}${row}`);
      if (withNewline || index < rows.length - 1) emit("\n");
    }
  };

  const flushTable = (): void => {
    if (!table) return;
    emitRows(renderTableBlock(table.header, table.rows, wrapWidth, context.paint, wrapAnsiLine), table.withNewline);
    table = undefined;
  };

  const flushHeader = (): void => {
    if (!pendingHeader) return;
    emitRows(wrapMarkdownLine(pendingHeader.line, wrapWidth, context), pendingHeader.withNewline);
    pendingHeader = undefined;
  };

  const handleLine = (line: string, withNewline: boolean): void => {
    const fenceRows = fencePanelRows(line, state, context);
    const cells = fenceRows ? undefined : parseTableRow(line);
    if (table && cells) {
      table.rows.push(cells);
      table.withNewline = withNewline;
      return;
    }
    flushTable();

    const header = fenceRows ? undefined : matchTableHeader(pendingHeader?.cells, line);
    if (header) {
      table = { header, rows: [], withNewline };
      pendingHeader = undefined;
      return;
    }

    flushHeader();
    if (cells) pendingHeader = { line, cells, withNewline };
    else emitRows(fenceRows ?? wrapMarkdownLine(line, wrapWidth, context), withNewline);
  };

  return {
    push(token: string): void {
      buffer += token;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        handleLine(line, true);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    finish(): void {
      if (buffer.length > 0) {
        handleLine(buffer, false);
        buffer = "";
      }
      flushTable();
      flushHeader();
      if (state.inFence) {
        const separator = outputEndsWithNewline ? "" : "\n";
        emit(`${separator}${OUTPUT_INDENT}${closeFencePanel(state, context)}`);
      }
    },
  };
}

const SGR = /\x1b\[[0-9;]*m/g;
const WRAP_PART = /\x1b\[[0-9;]*m| +|[^ \x1b]+|\x1b/g;
const WORD_PART = /\x1b\[[0-9;]*m|[^\x1b]+|\x1b/g;
const NON_ASCII = /[^ -~]/;
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

interface Style {
  readonly attributes: Set<number>;
  fg: string;
  bg: string;
}

const ATTRIBUTE_CLOSES: Readonly<Record<number, readonly number[]>> = {
  22: [1, 2],
  23: [3],
  24: [4],
  29: [9],
};

function applyStyle(style: Style, sequence: string): void {
  const codes = sequence.slice(2, -1).split(";").map(Number);
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i]!;
    if (code === 0) {
      style.attributes.clear();
      style.fg = "";
      style.bg = "";
    } else if (code === 38 || code === 48) {
      const mode = codes[i + 1];
      const args = mode === 2 ? 4 : mode === 5 ? 2 : 0;
      if (args > 0 && i + args < codes.length) {
        style[code === 38 ? "fg" : "bg"] = `\x1b[${codes.slice(i, i + args + 1).join(";")}m`;
        i += args;
      }
    } else if (code === 39) {
      style.fg = "";
    } else if (code === 49) {
      style.bg = "";
    } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      style.fg = `\x1b[${code}m`;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      style.bg = `\x1b[${code}m`;
    } else if ((code >= 1 && code <= 4) || code === 9) {
      style.attributes.add(code);
    } else {
      for (const attribute of ATTRIBUTE_CLOSES[code] ?? []) style.attributes.delete(attribute);
    }
  }
}

function* glyphs(text: string): Iterable<string> {
  if (!NON_ASCII.test(text)) {
    yield* text;
    return;
  }
  for (const { segment } of SEGMENTER.segment(text)) yield segment;
}

export function wrapAnsiLine(source: string, maxWidth: number): string[] {
  const width = Math.max(1, Math.floor(maxWidth));
  const text = source.includes("\t") ? source.replaceAll("\t", "    ") : source;
  if (terminalWidth(text) <= width) return [text];

  const lines: string[] = [];
  const style: Style = { attributes: new Set(), fg: "", bg: "" };
  let line = "";
  let used = 0;
  let word = "";
  let gap = "";
  let gapWidth = 0;

  const flush = (): void => {
    const attributes = Array.from(style.attributes, (code) => `\x1b[${code}m`).join("");
    const reopen = attributes + style.fg + style.bg;
    lines.push(reopen ? `${line}\x1b[0m` : line);
    line = reopen;
    used = 0;
  };

  const writeStyled = (value: string): void => {
    line += value;
    if (value.includes("\x1b")) {
      for (const [sequence] of value.matchAll(SGR)) applyStyle(style, sequence);
    }
  };

  const writeWord = (): void => {
    if (!word) return;
    const columns = terminalWidth(word);
    if (columns === 0) {
      gap += word;
      word = "";
      return;
    }
    if (used > 0 && used + gapWidth + columns > width) flush();
    writeStyled(used > 0 ? gap : gap.replace(/ +/g, ""));
    if (used > 0) used += gapWidth;
    gap = "";
    gapWidth = 0;

    if (columns <= width) {
      writeStyled(word);
      used += columns;
    } else {
      for (const [part] of word.matchAll(WORD_PART)) {
        if (part.startsWith("\x1b")) {
          line += part;
          if (part.endsWith("m")) applyStyle(style, part);
          continue;
        }
        for (const glyph of glyphs(part)) {
          const size = terminalWidth(glyph);
          if (used > 0 && used + size > width) flush();
          line += glyph;
          used += size;
        }
      }
    }
    word = "";
  };

  for (const [part] of text.matchAll(WRAP_PART)) {
    if (part.startsWith(" ")) {
      writeWord();
      gap += part;
      gapWidth += part.length;
    } else {
      word += part;
    }
  }
  writeWord();
  if (used > 0) {
    writeStyled(gap.replace(/ +/g, ""));
    flush();
  }
  return lines.length > 0 ? lines : [" ".repeat(width)];
}
