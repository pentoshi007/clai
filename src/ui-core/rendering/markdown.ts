import chalk from "chalk";
import { renderColumns } from "./text-width.js";
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
  type CodeFenceState,
} from "./code-block.js";

// Lightweight terminal markdown renderer that styles **bold**, *italic*,
// `code`, links, headings, lists, blockquotes, hrules, and ```fenced```
// code blocks. Designed to work both for one-shot strings and for
// token-streaming inputs (line-buffered).

function repeat(char: string, count: number): string {
  return char.repeat(Math.max(0, count));
}

// Walk inline markdown tokens and convert them to ANSI styles. Designed to
// handle one logical line at a time (so it can run after a newline arrives
// in the token stream).
export function renderInlineMarkdown(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // ``code`` (longer fences first to avoid eating the inner ticks)
    if (text.startsWith("``", i)) {
      const end = text.indexOf("``", i + 2);
      if (end > i + 2) {
        out += chalk.cyan(`\`${text.slice(i + 2, end)}\``);
        i = end + 2;
        continue;
      }
    }

    // `code`
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        out += chalk.cyan(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    }

    // ***bold-italic***
    if (text.startsWith("***", i)) {
      const end = text.indexOf("***", i + 3);
      if (end > i + 3) {
        out += chalk.bold.italic(renderInlineMarkdown(text.slice(i + 3, end)));
        i = end + 3;
        continue;
      }
    }

    // **bold**
    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        out += chalk.bold(renderInlineMarkdown(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    // __bold__
    if (text.startsWith("__", i)) {
      const end = text.indexOf("__", i + 2);
      if (end > i + 2) {
        out += chalk.bold(renderInlineMarkdown(text.slice(i + 2, end)));
        i = end + 2;
        continue;
      }
    }

    // *italic* — only when surrounded by non-word boundaries to avoid
    // chewing through `*` characters in code or maths.
    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end + 1] !== "*") {
        const inner = text.slice(i + 1, end);
        if (
          inner.length > 0 &&
          !inner.startsWith(" ") &&
          !inner.endsWith(" ")
        ) {
          out += chalk.italic(renderInlineMarkdown(inner));
          i = end + 1;
          continue;
        }
      }
    }

    // _italic_ (skip if it looks like part of a snake_case word)
    if (text[i] === "_") {
      const prev = text[i - 1];
      const isWordBoundary = !prev || /[\s\W]/.test(prev);
      if (isWordBoundary) {
        const end = text.indexOf("_", i + 1);
        if (end > i + 1) {
          const after = text[end + 1];
          const isAfterBoundary = !after || /[\s\W]/.test(after);
          const inner = text.slice(i + 1, end);
          if (
            isAfterBoundary &&
            inner.length > 0 &&
            !inner.startsWith(" ") &&
            !inner.endsWith(" ")
          ) {
            out += chalk.italic(renderInlineMarkdown(inner));
            i = end + 1;
            continue;
          }
        }
      }
    }

    // ~~strike~~
    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        out += chalk.strikethrough(
          renderInlineMarkdown(text.slice(i + 2, end)),
        );
        i = end + 2;
        continue;
      }
    }

    // [label](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close + 2) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, urlEnd);
          out += chalk.cyan.underline(label) + chalk.dim(`(${url})`);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    out += text[i];
    i += 1;
  }
  return out;
}

interface BlockState {
  inFence: boolean;
  /** Code panel width follows the wrap budget so long code stays inside it. */
  fenceWidth?: number;
  fence?: CodeFenceState | undefined;
}

const DEFAULT_FENCE_WIDTH = 60;

function panelWidth(state: BlockState): number {
  return codeBlockWidth(state.fenceWidth ?? DEFAULT_FENCE_WIDTH);
}

function openFencePanel(state: BlockState, marker: string, info: string): string {
  state.inFence = true;
  state.fence = openCodeFence(marker, info);
  return codeBlockTop(state.fence.label, panelWidth(state));
}

function closeFencePanel(state: BlockState): string {
  state.inFence = false;
  state.fence = undefined;
  return codeBlockBottom(panelWidth(state));
}

/**
 * Render a complete fence as a content-sized panel. Used by the one-shot
 * renderer (chat + pager), which can see the whole block before it paints.
 * An unterminated fence still gets a footer so a streaming reply reads as a
 * finished box.
 */
function renderCodeBlock(
  open: { marker: string; info: string },
  bodyLines: readonly string[],
  wrapWidth: number,
): string[] {
  const fence = openCodeFence(open.marker, open.info);
  const body = trimCodeBlockBody(bodyLines);
  const width = codeBlockFitWidth(body, fence.label, wrapWidth);
  const out = [codeBlockTop(fence.label, width)];
  for (const line of body) {
    out.push(...codeBlockRows(line, fence, width));
  }
  out.push(codeBlockBottom(width));
  return out;
}

/** Fence lines and code bodies as complete panel rows (may be empty). */
function fencePanelRows(line: string, state: BlockState): string[] | undefined {
  if (state.inFence && state.fence) {
    if (isCodeFenceClose(line, state.fence.marker)) {
      return [closeFencePanel(state)];
    }
    return codeBlockRows(line, state.fence, panelWidth(state));
  }
  const open = matchCodeFenceOpen(line);
  if (!open) return undefined;
  return [openFencePanel(state, open.marker, open.info)];
}

function renderBlockLine(line: string, state: BlockState): string {
  // Headings
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const level = heading[1]!.length;
    const body = heading[2]!.trim();
    if (level <= 2) return chalk.bold.magenta(renderInlineMarkdown(body));
    if (level === 3) return chalk.bold.cyan(renderInlineMarkdown(body));
    return chalk.bold(renderInlineMarkdown(body));
  }

  // Horizontal rule
  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    return chalk.dim(repeat("─", 60));
  }

  // Markdown table separator: | --- | --- |
  if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)) {
    return chalk.dim(repeat("─", Math.max(20, line.length)));
  }

  // Markdown table row: | cell | cell |
  if (/^\s*\|.*\|\s*$/.test(line)) {
    const cells = line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => renderInlineMarkdown(cell.trim()));
    return chalk.dim("│ ") + cells.join(chalk.dim(" │ ")) + chalk.dim(" │");
  }

  // Blockquote
  if (line.startsWith("> ")) {
    return (
      chalk.dim("│ ") + chalk.dim.italic(renderInlineMarkdown(line.slice(2)))
    );
  }

  // GitHub-style task list: - [ ] todo  /  - [x] done
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const checked = /[xX]/.test(task[2]!);
    const box = checked ? chalk.green("☑") : chalk.dim("☐");
    const body = renderInlineMarkdown(task[3]!);
    return `${task[1]}${box} ${checked ? chalk.dim(body) : body}`;
  }

  // Ordered list
  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    return `${ordered[1]}${chalk.cyan(`${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3]!)}`;
  }

  // Unordered list
  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    return `${unordered[1]}${chalk.cyan("•")} ${renderInlineMarkdown(unordered[2]!)}`;
  }

  return renderInlineMarkdown(line);
}

/** Left margin for all rendered output so text doesn't go edge-to-edge. */
const OUTPUT_INDENT = "  ";

// Visible column width of a string, accounting for ANSI escapes (stripped)
// AND wide characters (emoji, CJK) that occupy 2 terminal columns each but
// only 1 JS string index. Using `.length` here under-counts glyphs like
// ✅/⚠️/❓, which desynced column math and let table borders drift and get
// clipped by the TUI's width-aware truncation.
export function visibleWidth(str: string): number {
  return renderColumns(str);
}

type Token = { type: "space" | "ansi" | "char"; value: string; width: number };

/** Active SGR style that must reopen on soft-wrap continuation lines. */
interface SgrCarry {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  /** Full CSI sequence for foreground (e.g. `\x1b[36m` or `\x1b[38;2;…m`). */
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

/** Apply one CSI … m sequence into a mutable style carry. */
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
    // 256-color / truecolor FG
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
    // 256-color / truecolor BG
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

/** Walk text and update style state for every SGR sequence found. */
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
      // type === "char" (may be a wide glyph worth 2 columns)
      if (
        currentSegmentVisibleLength > 0 &&
        currentSegmentVisibleLength + token.width > maxWidth
      ) {
        // Close open styles on this segment; next segment reopens them.
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

/**
 * Soft-wrap a line that may contain ANSI SGR styles.
 * Continuation lines re-open any style still active at the break so cyan/bold
 * etc. never fall back to the default body color mid-phrase.
 */
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
      // Advance by a full Unicode code point (not a UTF-16 code unit) so a
      // surrogate-pair emoji is never split in half, then measure its real
      // terminal column width (many emoji/symbols render as 2 columns).
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
    // Close open styles so the next physical row starts clean, then reopen.
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
      // Re-open styles active after the previous wrap break.
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
      // lineStyle still holds the style at end of previous line — reopen it.
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
): string[] {
  // Keep panel chrome + code within wrapWidth (never truncate with …).
  state.fenceWidth = wrapWidth;
  const fenceRows = fencePanelRows(line, state);
  if (fenceRows) return fenceRows;

  // If it's a horizontal rule, don't wrap it
  if (/^\s*[-*_]{3,}\s*$/.test(line)) {
    return [renderBlockLine(line, state)];
  }

  // Check if it's a blockquote
  if (line.startsWith("> ")) {
    const content = line.slice(2);
    const prefix = chalk.dim("│ ");
    const renderedContent = renderInlineMarkdown(content);
    // Wrap the content at wrapWidth - 2 (since prefix is 2 chars)
    const wrapped = wrapAnsiLine(renderedContent, Math.max(10, wrapWidth - 2));
    return wrapped.map((wl) => prefix + chalk.dim.italic(wl));
  }

  // Check if it's a task list
  const task = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/);
  if (task) {
    const indent = task[1] ?? "";
    const checked = /[xX]/.test(task[2]!);
    const box = checked ? chalk.green("☑") : chalk.dim("☐");
    const content = task[3] ?? "";
    const prefix = `${indent}${box} `;
    const prefixLength = indent.length + 2;
    let renderedContent = renderInlineMarkdown(content);
    if (checked) {
      renderedContent = chalk.dim(renderedContent);
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

  // Check if it's an ordered list
  const ordered = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
  if (ordered) {
    const indent = ordered[1] ?? "";
    const num = ordered[2] ?? "";
    const content = ordered[3] ?? "";
    const prefix = `${indent}${chalk.cyan(`${num}.`)} `;
    const prefixLength = indent.length + num.length + 2;
    const renderedContent = renderInlineMarkdown(content);
    const wrapped = wrapAnsiLine(
      renderedContent,
      Math.max(10, wrapWidth - prefixLength),
    );
    return wrapped.map((wl, idx) => {
      if (idx === 0) return prefix + wl;
      return " ".repeat(prefixLength) + wl;
    });
  }

  // Check if it's an unordered list
  const unordered = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (unordered) {
    const indent = unordered[1] ?? "";
    const content = unordered[2] ?? "";
    const prefix = `${indent}${chalk.cyan("•")} `;
    const prefixLength = indent.length + 2;
    const renderedContent = renderInlineMarkdown(content);
    const wrapped = wrapAnsiLine(
      renderedContent,
      Math.max(10, wrapWidth - prefixLength),
    );
    return wrapped.map((wl, idx) => {
      if (idx === 0) return prefix + wl;
      return " ".repeat(prefixLength) + wl;
    });
  }

  // Otherwise, treat as a normal paragraph/line
  const rendered = renderBlockLine(line, state);
  return wrapAnsiLine(rendered, wrapWidth);
}

// Markdown tables
// `<br>` (and `<br/>`, `<br />`) inside cells become stacked lines.
const BR_RE = /<br\s*\/?>/i;
const BR_RE_GLOBAL = /<br\s*\/?>/gi;

type ColumnAlign = "left" | "center" | "right";

/** A `| cell | cell |` style row (must open and close with a pipe). */
function isTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** A `| --- | :--: |` style alignment/separator row. */
function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/** Split a table row into trimmed cells, honoring escaped `\|`. */
function splitTableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** Derive per-column alignment from the `:---:` markers in the separator. */
function parseColumnAligns(separator: string, columns: number): ColumnAlign[] {
  const cells = splitTableCells(separator);
  const aligns: ColumnAlign[] = [];
  for (let c = 0; c < columns; c++) {
    const cell = (cells[c] ?? "").trim();
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

interface CellLine {
  rendered: string;
  width: number;
}

function padCell(
  rendered: string,
  contentWidth: number,
  columnWidth: number,
  align: ColumnAlign,
): string {
  const slack = Math.max(0, columnWidth - contentWidth);
  if (align === "right") return " ".repeat(slack) + rendered;
  if (align === "center") {
    const left = Math.floor(slack / 2);
    return " ".repeat(left) + rendered + " ".repeat(slack - left);
  }
  return rendered + " ".repeat(slack);
}

/**
 * Render a contiguous markdown table (header row, separator row, then
 * zero or more body rows) into aligned, box-drawn terminal lines.
 *
 * Columns are sized to their content, shrunk to fit `availWidth` when
 * necessary (widest column first, never below one visible column), and
 * `<br>` markers split a cell into stacked lines so multi-line cells
 * stay inside their column instead of bleeding across the row.
 */
function renderTableBlock(rawLines: string[], availWidth: number): string[] {
  const separatorIndex = rawLines.findIndex(isTableSeparatorLine);
  const headerLines =
    separatorIndex > 0
      ? rawLines.slice(0, separatorIndex)
      : [rawLines[0] ?? ""];
  const separatorLine = separatorIndex >= 0 ? rawLines[separatorIndex]! : "";
  const bodyLines = (
    separatorIndex >= 0 ? rawLines.slice(separatorIndex + 1) : rawLines.slice(1)
  ).filter((l) => l.trim().length > 0);

  const headerCellRows = headerLines.map(splitTableCells);
  const bodyCellRows = bodyLines.map(splitTableCells);
  const columns = Math.max(
    1,
    ...headerCellRows.map((r) => r.length),
    ...bodyCellRows.map((r) => r.length),
  );
  const aligns = parseColumnAligns(separatorLine, columns);

  const toCell = (text: string): CellLine[] =>
    text.split(BR_RE_GLOBAL).map((part) => {
      const trimmed = part.trim();
      const bulletMatch = trimmed.match(/^([-\*+])\s+(.*)$/);
      if (bulletMatch) {
        const content = renderInlineMarkdown(bulletMatch[2]!);
        const rendered = `${chalk.cyan("•")} ${content}`;
        return { rendered, width: visibleWidth(rendered) };
      }
      const numberMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (numberMatch) {
        const content = renderInlineMarkdown(numberMatch[2]!);
        const rendered = `${chalk.cyan(`${numberMatch[1]}.`)} ${content}`;
        return { rendered, width: visibleWidth(rendered) };
      }
      const rendered = renderInlineMarkdown(trimmed);
      return { rendered, width: visibleWidth(rendered) };
    });

  const buildRow = (cells: string[]): CellLine[][] => {
    const row: CellLine[][] = [];
    for (let c = 0; c < columns; c++) row.push(toCell(cells[c] ?? ""));
    return row;
  };

  const headerRows = headerCellRows.map(buildRow);
  const bodyRows = bodyCellRows.map(buildRow);

  // Natural column widths (floor of 1 so empty columns still render).
  const colWidths = new Array<number>(columns).fill(1);
  for (const row of [...headerRows, ...bodyRows]) {
    for (let c = 0; c < columns; c++) {
      for (const cell of row[c] ?? []) {
        if (cell.width > colWidths[c]!) colWidths[c] = cell.width;
      }
    }
  }

  // Shrink to fit: each column costs width + 2 padding spaces, plus one
  // vertical border per column and a leading border (3*columns + 1). Reserve
  // one extra column of margin so an exact-fit table can't be clipped by the
  // TUI's own width-aware truncation (e.g. small rounding differences
  // between this module's width math and the terminal renderer's).
  const budget = Math.max(columns, availWidth - (3 * columns + 1) - 1);
  let total = colWidths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let c = 1; c < columns; c++) {
      if (colWidths[c]! > colWidths[widest]!) widest = c;
    }
    if (colWidths[widest]! <= 1) break;
    colWidths[widest]!--;
    total--;
  }

  const wrapCell = (cell: CellLine[], width: number): CellLine[] => {
    const out: CellLine[] = [];
    for (const line of cell) {
      for (const piece of wrapAnsiLine(line.rendered, width)) {
        // Drop any trailing spaces a wrap left behind so the cell's
        // right border stays aligned (padCell re-adds exact padding).
        const trimmed = piece.replace(/ +$/, "");
        out.push({ rendered: trimmed, width: visibleWidth(trimmed) });
      }
    }
    return out.length > 0 ? out : [{ rendered: "", width: 0 }];
  };

  const dim = chalk.dim;
  const renderRow = (row: CellLine[][], bold: boolean): string[] => {
    const wrapped = row.map((cell, c) => wrapCell(cell, colWidths[c]!));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    const lines: string[] = [];
    for (let h = 0; h < height; h++) {
      let s = dim("│");
      for (let c = 0; c < columns; c++) {
        const piece = wrapped[c]![h] ?? { rendered: "", width: 0 };
        const content =
          bold && piece.rendered ? chalk.bold(piece.rendered) : piece.rendered;
        s +=
          " " +
          padCell(content, piece.width, colWidths[c]!, aligns[c]!) +
          " " +
          dim("│");
      }
      lines.push(s);
    }
    return lines;
  };

  const border = (left: string, mid: string, right: string): string => {
    let s = left;
    for (let c = 0; c < columns; c++) {
      s += "─".repeat(colWidths[c]! + 2);
      s += c < columns - 1 ? mid : right;
    }
    return dim(s);
  };

  const out: string[] = [border("┌", "┬", "┐")];
  for (const row of headerRows) out.push(...renderRow(row, true));
  out.push(border("├", "┼", "┤"));
  for (let i = 0; i < bodyRows.length; i++) {
    if (i > 0) {
      const spacer = Array.from({ length: columns }, () => [
        { rendered: "", width: 0 },
      ]);
      out.push(...renderRow(spacer, false));
    }
    out.push(...renderRow(bodyRows[i]!, false));
  }
  out.push(border("└", "┴", "┘"));
  return out;
}

export function renderMarkdown(text: string, width?: number): string {
  if (!text) return text;
  const state: BlockState = { inFence: false };
  const lines = text.split("\n");
  const resultLines: string[] = [];

  const hasWidth = typeof width === "number";
  const cols = width ?? (process.stdout.columns || 80);
  const wrapWidth = hasWidth ? Math.max(12, cols - 2) : Math.max(40, cols - 6);

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code is consumed as a whole block so the panel can be sized to
    // its widest line instead of stretching a one-liner across the pane.
    // Also keeps table/`<br>` heuristics away from code bodies entirely.
    const fenceOpen = matchCodeFenceOpen(line);
    if (fenceOpen) {
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length && !isCodeFenceClose(lines[j]!, fenceOpen.marker)) {
        body.push(lines[j]!);
        j += 1;
      }
      for (const rendered of renderCodeBlock(fenceOpen, body, wrapWidth)) {
        resultLines.push(`${OUTPUT_INDENT}${rendered}`);
      }
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    // A table is a row line immediately followed by a separator line.
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
      for (const rendered of renderTableBlock(block, wrapWidth)) {
        resultLines.push(`${OUTPUT_INDENT}${rendered}`);
      }
      i = j;
      continue;
    }

    // Expand `<br>` into real line breaks outside fences/tables.
    const pieces =
      !state.inFence && BR_RE.test(line) ? line.split(BR_RE_GLOBAL) : [line];
    for (const piece of pieces) {
      for (const wl of wrapMarkdownLine(piece, wrapWidth, state)) {
        resultLines.push(`${OUTPUT_INDENT}${wl}`);
      }
    }
    i++;
  }

  // A fence still open at the end means the reply is mid-stream or the model
  // never closed it — footer it so the panel always reads as a finished box.
  if (state.inFence) {
    resultLines.push(`${OUTPUT_INDENT}${closeFencePanel(state)}`);
  }
  return resultLines.join("\n");
}

// Streaming variant: buffers tokens and emits ANSI-rendered output
// whenever a complete line arrives. Fenced code blocks stream as a bordered,
// syntax-highlighted panel.
export function createMarkdownStreamWriter(write: (chunk: string) => void): {
  push(token: string): void;
  finish(): void;
} {
  const state: BlockState = { inFence: false };
  let buffer = "";
  let outputEndsWithNewline = true;
  // Table rows are buffered until the block ends so columns can be
  // sized across every row before anything is emitted.
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
      const physical = wrapMarkdownLine(piece, wrapWidth, state);
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
      for (const rendered of renderTableBlock(tableBuffer, wrapWidth)) {
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
        // Close the panel without inserting a blank row after completed lines.
        const separator = outputEndsWithNewline ? "" : "\n";
        emit(`${separator}${OUTPUT_INDENT}${closeFencePanel(state)}`);
      }
    },
  };
}
