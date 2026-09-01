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
import { BR_RE_GLOBAL, isTableRowLine, isTableSeparatorLine, renderInlineMarkdown, renderTableBlock } from "./markdown/tables.js";

import { renderColumns } from "./text-width.js";
export { renderInlineMarkdown };

const CHALK_LEVEL: Record<ColorMode, 0 | 1 | 2 | 3> = {
  none: 0,
  "16": 1,
  "256": 2,
  truecolor: 3,
};

export type MarkdownAppearance = CodeBlockAppearance;

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

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
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
  const width = codeBlockFitWidth(body, fence.label, wrapWidth);
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

function renderBlockLine(
  line: string,
  state: BlockState,
  context: RenderContext,
): string {
  const { paint } = context;
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1]!.length;
    const body = heading[2]!.trim();
    if (level <= 2) {
      return paint.bold.magenta(renderInlineMarkdown(body, paint));
    }
    if (level === 3) {
      return paint.bold.cyan(renderInlineMarkdown(body, paint));
    }
    return paint.bold(renderInlineMarkdown(body, paint));
  }

  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    return paint.dim(repeat("─", 60));
  }

  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
    return paint.dim(repeat("─", Math.max(20, line.length)));
  }

  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => renderInlineMarkdown(cell.trim(), paint));
    return (
      paint.dim("│ ") + cells.join(paint.dim(" │ ")) + paint.dim(" │")
    );
  }

  if (line.startsWith("> ")) {
    return (
      paint.dim("│ ") +
      paint.dim.italic(renderInlineMarkdown(line.slice(2), paint))
    );
  }

  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = /[xX]/.test(task[2]!);
    const box = checked ? paint.green("☑") : paint.dim("☐");
    const body = renderInlineMarkdown(task[3]!, paint);
    return `${task[1]}${box} ${checked ? paint.dim(body) : body}`;
  }

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${paint.cyan(`${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3]!, paint)}`;
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    return `${unordered[1]}${paint.cyan("•")} ${renderInlineMarkdown(unordered[2]!, paint)}`;
  }

  return renderInlineMarkdown(line, paint);
}

const OUTPUT_INDENT = "  ";

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

function wrapMarkdownLine(
  line: string,
  wrapWidth: number,
  state: BlockState,
  context: RenderContext,
): string[] {
  const { paint } = context;
  state.fenceWidth = wrapWidth;
  const fenceRows = fencePanelRows(line, state, context);
  if (fenceRows) return fenceRows;

  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    return [renderBlockLine(line, state, context)];
  }

  if (line.startsWith("> ")) {
    const content = line.slice(2);
    const prefix = paint.dim("│ ");
    const renderedContent = renderInlineMarkdown(content, paint);
    const wrapped = wrapAnsiLine(renderedContent, Math.max(10, wrapWidth - 2));
    return wrapped.map((wl) => prefix + paint.dim.italic(wl));
  }

  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const indent = task[1] ?? "";
    const checked = /[xX]/.test(task[2]!);
    const box = checked ? paint.green("☑") : paint.dim("☐");
    const content = task[3] ?? "";
    const prefix = `${indent}${box} `;
    const prefixLength = indent.length + 2;
    let renderedContent = renderInlineMarkdown(content, paint);
    if (checked) {
      renderedContent = paint.dim(renderedContent);
    }
    const wrapped = wrapAnsiLine(
      renderedContent,
      Math.max(10, wrapWidth - prefixLength),
    );
    return wrapped.map((wl, idx) => {
      if (idx === 0) return prefix + wl;
      return " ".repeat(prefixLength) + wl;
    });
  }

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    const indent = ordered[1] ?? "";
    const num = ordered[2] ?? "";
    const content = ordered[3] ?? "";
    const prefix = `${indent}${paint.cyan(`${num}.`)} `;
    const prefixLength = indent.length + num.length + 2;
    const renderedContent = renderInlineMarkdown(content, paint);
    const wrapped = wrapAnsiLine(
      renderedContent,
      Math.max(10, wrapWidth - prefixLength),
    );
    return wrapped.map((wl, idx) => {
      if (idx === 0) return prefix + wl;
      return " ".repeat(prefixLength) + wl;
    });
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    const indent = unordered[1] ?? "";
    const content = unordered[2] ?? "";
    const prefix = `${indent}${paint.cyan("•")} `;
    const prefixLength = indent.length + 2;
    const renderedContent = renderInlineMarkdown(content, paint);
    const wrapped = wrapAnsiLine(
      renderedContent,
      Math.max(10, wrapWidth - prefixLength),
    );
    return wrapped.map((wl, idx) => {
      if (idx === 0) return prefix + wl;
      return " ".repeat(prefixLength) + wl;
    });
  }

  const rendered = renderBlockLine(line, state, context);
  return wrapAnsiLine(rendered, wrapWidth);
}

const BR_RE = /<br\s*\/?>/i;

export function renderMarkdown(
  text: string,
  width?: number,
  appearance?: MarkdownAppearance,
): string {
  if (!text) return text;
  const context = renderContext(appearance);
  const state: BlockState = { inFence: false };
  const lines = text.split("\n");
  const resultLines: string[] = [];

  const hasWidth = typeof width === "number";
  const cols = width ?? (process.stdout.columns || 80);
  const wrapWidth = hasWidth ? Math.max(12, cols - 2) : Math.max(40, cols - 6);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

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

    if (
      !state.inFence &&
      isTableRowLine(line) &&
      i + 1 < lines.length &&
      isTableSeparatorLine(lines[i + 1]!)
    ) {
      const block: string[] = [line, lines[i + 1]!];
      let j = i + 2;
      while (
        j < lines.length &&
        lines[j]!.trim().length > 0 &&
        (isTableRowLine(lines[j]!) || isTableSeparatorLine(lines[j]!))
      ) {
        block.push(lines[j]!);
        j++;
      }
      for (const rendered of renderTableBlock(
        block,
        wrapWidth,
        context.paint,
      )) {
        resultLines.push(`${OUTPUT_INDENT}${rendered}`);
      }
      i = j;
      continue;
    }

    const pieces =
      !state.inFence && BR_RE.test(line) ? line.split(BR_RE_GLOBAL) : [line];
    for (const piece of pieces) {
      for (const wl of wrapMarkdownLine(piece, wrapWidth, state, context)) {
        resultLines.push(`${OUTPUT_INDENT}${wl}`);
      }
    }
    i++;
  }

  if (state.inFence) {
    resultLines.push(`${OUTPUT_INDENT}${closeFencePanel(state, context)}`);
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
  const state: BlockState = { inFence: false };
  let buffer = "";
  let outputEndsWithNewline = true;
  let tableBuffer: string[] = [];

  const cols = process.stdout.columns || 80;
  const wrapWidth = Math.max(40, cols - 6);

  const emit = (chunk: string): void => {
    if (!chunk) return;
    write(chunk);
    outputEndsWithNewline = chunk.endsWith("\n");
  };

  const emitLine = (line: string, withNewline: boolean): void => {
    const pieces =
      !state.inFence && BR_RE.test(line) ? line.split(BR_RE_GLOBAL) : [line];
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p]!;
      const lastPiece = p === pieces.length - 1;
      const physical = wrapMarkdownLine(piece, wrapWidth, state, context);
      for (let q = 0; q < physical.length; q++) {
        emit(`${OUTPUT_INDENT}${physical[q]!}`);
        const isVeryLast = lastPiece && q === physical.length - 1;
        if (!isVeryLast || withNewline) emit("\n");
      }
    }
  };

  const flushTable = (): void => {
    if (tableBuffer.length === 0) return;
    const looksLikeTable =
      tableBuffer.length >= 2 &&
      isTableRowLine(tableBuffer[0]!) &&
      isTableSeparatorLine(tableBuffer[1]!);
    if (looksLikeTable) {
      for (const rendered of renderTableBlock(
        tableBuffer,
        wrapWidth,
        context.paint,
      )) {
        emit(`${OUTPUT_INDENT}${rendered}\n`);
      }
    } else {
      for (const line of tableBuffer) emitLine(line, true);
    }
    tableBuffer = [];
  };

  const handleLine = (line: string, withNewline: boolean): void => {
    const collecting = tableBuffer.length > 0;
    const isTableLine =
      !state.inFence &&
      (collecting
        ? isTableRowLine(line) || isTableSeparatorLine(line)
        : isTableRowLine(line));
    if (isTableLine) {
      tableBuffer.push(line);
      return;
    }
    flushTable();
    emitLine(line, withNewline);
  };

  return {
    push(token: string): void {
      buffer += token;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
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
      if (state.inFence) {
        const separator = outputEndsWithNewline ? "" : "\n";
        emit(`${separator}${OUTPUT_INDENT}${closeFencePanel(state, context)}`);
      }
    },
  };
}

export function visibleWidth(str: string): number {
  return renderColumns(str);
}
type Token = { type: "space" | "ansi" | "char"; value: string; width: number };
interface SgrCarry {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg?: string | undefined;
  bg?: string | undefined;
}
function emptySgr(): SgrCarry {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
}
function sgrOpen(state: SgrCarry): string {
  let out = "";
  if (state.bold) out += "\x1b[1m";
  if (state.dim) out += "\x1b[2m";
  if (state.italic) out += "\x1b[3m";
  if (state.underline) out += "\x1b[4m";
  if (state.fg) out += state.fg;
  if (state.bg) out += state.bg;
  return out;
}
function sgrHasStyle(state: SgrCarry): boolean {
  return Boolean(
    state.bold ||
      state.dim ||
      state.italic ||
      state.underline ||
      state.fg ||
      state.bg,
  );
}
function applySgrSequence(state: SgrCarry, sequence: string): void {
  if (!sequence.startsWith("\x1b[") || !sequence.endsWith("m")) return;
  const body = sequence.slice(2, -1);
  if (body.length === 0) {
    Object.assign(state, emptySgr());
    return;
  }
  const parts = body.split(";").map((p) => Number(p));
  let i = 0;
  while (i < parts.length) {
    const code = parts[i]!;
    if (!Number.isFinite(code)) {
      i += 1;
      continue;
    }
    if (code === 0) {
      Object.assign(state, emptySgr());
      i += 1;
      continue;
    }
    if (code === 1) {
      state.bold = true;
      i += 1;
      continue;
    }
    if (code === 2) {
      state.dim = true;
      i += 1;
      continue;
    }
    if (code === 3) {
      state.italic = true;
      i += 1;
      continue;
    }
    if (code === 4) {
      state.underline = true;
      i += 1;
      continue;
    }
    if (code === 22) {
      state.bold = false;
      state.dim = false;
      i += 1;
      continue;
    }
    if (code === 23) {
      state.italic = false;
      i += 1;
      continue;
    }
    if (code === 24) {
      state.underline = false;
      i += 1;
      continue;
    }
    if (code === 39) {
      state.fg = undefined;
      i += 1;
      continue;
    }
    if (code === 49) {
      state.bg = undefined;
      i += 1;
      continue;
    }
    if (code === 38) {
      const mode = parts[i + 1];
      if (mode === 5 && parts[i + 2] !== undefined) {
        state.fg = `\x1b[38;5;${parts[i + 2]}m`;
        i += 3;
        continue;
      }
      if (
        mode === 2 &&
        parts[i + 2] !== undefined &&
        parts[i + 3] !== undefined &&
        parts[i + 4] !== undefined
      ) {
        state.fg = `\x1b[38;2;${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}m`;
        i += 5;
        continue;
      }
      i += 1;
      continue;
    }
    if (code === 48) {
      const mode = parts[i + 1];
      if (mode === 5 && parts[i + 2] !== undefined) {
        state.bg = `\x1b[48;5;${parts[i + 2]}m`;
        i += 3;
        continue;
      }
      if (
        mode === 2 &&
        parts[i + 2] !== undefined &&
        parts[i + 3] !== undefined &&
        parts[i + 4] !== undefined
      ) {
        state.bg = `\x1b[48;2;${parts[i + 2]};${parts[i + 3]};${parts[i + 4]}m`;
        i += 5;
        continue;
      }
      i += 1;
      continue;
    }
    if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
      state.fg = `\x1b[${code}m`;
      i += 1;
      continue;
    }
    if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      state.bg = `\x1b[${code}m`;
      i += 1;
      continue;
    }
    i += 1;
  }
}
function applySgrInText(state: SgrCarry, text: string): void {
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("\x1b[", i)) {
      const end = text.indexOf("m", i + 2);
      if (end === -1) {
        i += 1;
        continue;
      }
      applySgrSequence(state, text.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    i += 1;
  }
}
function splitWord(
  tokens: Token[],
  maxWidth: number,
): { text: string; visibleLength: number }[] {
  const segments: { text: string; visibleLength: number }[] = [];
  let currentSegmentText = "";
  let currentSegmentVisibleLength = 0;
  const style = emptySgr();

  for (const token of tokens) {
    if (token.type === "ansi") {
      currentSegmentText += token.value;
      applySgrSequence(style, token.value);
    } else {
      if (
        currentSegmentVisibleLength > 0 &&
        currentSegmentVisibleLength + token.width > maxWidth
      ) {
        const open = sgrOpen(style);
        const closed = sgrHasStyle(style)
          ? `${currentSegmentText}\x1b[0m`
          : currentSegmentText;
        segments.push({
          text: closed,
          visibleLength: currentSegmentVisibleLength,
        });
        currentSegmentText = open;
        currentSegmentVisibleLength = 0;
      }
      currentSegmentText += token.value;
      currentSegmentVisibleLength += token.width;
    }
  }
  if (currentSegmentText) {
    segments.push({
      text: currentSegmentText,
      visibleLength: currentSegmentVisibleLength,
    });
  }
  return segments;
}
export function wrapAnsiLine(line: string, maxWidth: number): string[] {
  const visibleLength = visibleWidth(line);
  if (visibleLength <= maxWidth) return [line];

  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (line.startsWith("\x1b[", i)) {
      let j = i + 2;
      while (j < line.length && !/[a-zA-Z]/.test(line[j]!)) {
        j++;
      }
      const val = line.slice(i, j + 1);
      tokens.push({ type: "ansi", value: val, width: 0 });
      i = j + 1;
    } else if (/\s/.test(line[i]!)) {
      let j = i;
      while (j < line.length && /\s/.test(line[j]!)) {
        j++;
      }
      const val = line.slice(i, j);
      tokens.push({ type: "space", value: val, width: val.length });
      i = j;
    } else {
      const codePoint = line.codePointAt(i)!;
      const charLength = codePoint > 0xffff ? 2 : 1;
      const val = line.slice(i, i + charLength);
      tokens.push({
        type: "char",
        value: val,
        width: Math.max(1, visibleWidth(val)),
      });
      i += charLength;
    }
  }

  const words: { text: string; visibleLength: number }[] = [];
  let currentWordTokens: Token[] = [];
  let currentWordVisibleLength = 0;

  const pushWord = () => {
    if (currentWordTokens.length === 0) return;
    if (currentWordVisibleLength > maxWidth) {
      const segments = splitWord(currentWordTokens, maxWidth);
      words.push(...segments);
    } else {
      const text = currentWordTokens.map((t) => t.value).join("");
      words.push({ text, visibleLength: currentWordVisibleLength });
    }
    currentWordTokens = [];
    currentWordVisibleLength = 0;
  };

  for (const token of tokens) {
    if (token.type === "space") {
      pushWord();
      words.push({ text: token.value, visibleLength: token.width });
    } else {
      currentWordTokens.push(token);
      if (token.type === "char") {
        currentWordVisibleLength += token.width;
      }
    }
  }
  pushWord();

  const lines: string[] = [];
  let currentLineText = "";
  let currentLineVisibleLength = 0;
  const lineStyle = emptySgr();

  const flushLine = (): void => {
    const trimmed = currentLineText.replace(/\s+$/, "");
    if (!trimmed && lines.length === 0) return;
    const closed =
      sgrHasStyle(lineStyle) && !trimmed.endsWith("\x1b[0m")
        ? `${trimmed}\x1b[0m`
        : trimmed;
    lines.push(closed || " ");
  };

  for (const word of words) {
    if (/^\s+$/.test(word.text)) {
      if (currentLineVisibleLength > 0) {
        currentLineText += word.text;
        currentLineVisibleLength += word.visibleLength;
        applySgrInText(lineStyle, word.text);
      }
      continue;
    }

    if (currentLineVisibleLength === 0) {
      const reopen = sgrOpen(lineStyle);
      currentLineText = reopen + word.text;
      currentLineVisibleLength = word.visibleLength;
      applySgrInText(lineStyle, word.text);
    } else if (currentLineVisibleLength + word.visibleLength <= maxWidth) {
      currentLineText += word.text;
      currentLineVisibleLength += word.visibleLength;
      applySgrInText(lineStyle, word.text);
    } else {
      flushLine();
      const reopen = sgrOpen(lineStyle);
      currentLineText = reopen + word.text;
      currentLineVisibleLength = word.visibleLength;
      applySgrInText(lineStyle, word.text);
    }
  }
  if (currentLineVisibleLength > 0 || currentLineText.length > 0) {
    flushLine();
  }

  return lines.length > 0 ? lines : [line];
}
