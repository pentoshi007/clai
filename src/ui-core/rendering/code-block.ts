
import chalk from "chalk";
import { renderColumns } from "./text-width.js";
import { detectThemeHint } from "../bootstrap/capabilities.js";
import { themeFor } from "./theme.js";
import {
  emptyCarry,
  highlightLineForPath,
  type HighlightCarry,
  type SyntaxKind,
  type SyntaxSpan,
} from "./syntax-highlight.js";

export const CODE_BLOCK_CHROME = 4;

const TAB_WIDTH = 2;
const HANGING_INDENT = 2;
const MIN_BODY = 8;
const MIN_WIDTH = CODE_BLOCK_CHROME + MIN_BODY;
const MAX_WIDTH = 120;
const SOFT_BREAK_FLOOR = 0.5;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

type Paint = (text: string) => string;

interface Palette {
  readonly border: Paint;
  readonly label: Paint;
  readonly syntax: Readonly<Record<SyntaxKind, Paint>>;
}

function buildPalette(): Palette {
  const theme = themeFor(detectThemeHint(process.env));
  return {
    border: chalk.hex(theme.diffGutter),
    label: chalk.hex(theme.muted),
    syntax: {
      plain: chalk.hex(theme.foreground),
      keyword: chalk.hex(theme.synKeyword),
      string: chalk.hex(theme.synString),
      comment: chalk.hex(theme.synComment),
      number: chalk.hex(theme.synNumber),
      function: chalk.hex(theme.synFunction),
      type: chalk.hex(theme.synType),
      property: chalk.hex(theme.synProperty),
      operator: chalk.hex(theme.synOperator),
      punctuation: chalk.hex(theme.muted),
      regex: chalk.hex(theme.synRegex),
    },
  };
}

let resolvedPalette: Palette | undefined;

function palette(): Palette {
  resolvedPalette ??= buildPalette();
  return resolvedPalette;
}

const INFO_EXTENSION: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  node: "js",
  nodejs: "js",
  react: "jsx",
  python: "py",
  python3: "py",
  ipython: "py",
  shell: "sh",
  shellsession: "sh",
  console: "sh",
  terminal: "sh",
  golang: "go",
  rust: "rs",
  ruby: "rb",
  kotlin: "kt",
  csharp: "cs",
  "c#": "cs",
  "c++": "cpp",
  cplusplus: "cpp",
  objc: "m",
  "objective-c": "m",
  haskell: "hs",
  elixir: "ex",
  erlang: "erl",
  clojure: "clj",
  scheme: "scm",
  julia: "jl",
  docker: "dockerfile",
  make: "makefile",
  terraform: "tf",
  protobuf: "proto",
  postgres: "sql",
  postgresql: "sql",
  plpgsql: "sql",
  sqlite: "sql",
  powershell: "ps1",
  batch: "bat",
  vim: "txt",
  tex: "txt",
  latex: "txt",
  plaintext: "txt",
  plain: "txt",
  text: "txt",
  output: "txt",
  none: "txt",
};

const INFO_LABEL: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  kt: "kotlin",
  cs: "c#",
  cpp: "c++",
  sh: "shell",
  yml: "yaml",
  md: "markdown",
  ps1: "powershell",
  ex: "elixir",
  hs: "haskell",
  jl: "julia",
  clj: "clojure",
  tf: "terraform",
};

export interface CodeFenceState {
  readonly marker: string;
  readonly label: string;
  readonly langPath: string;
  readonly carry: HighlightCarry;
  pendingBlanks: number;
}

const FENCE_OPEN_RE = /^\s*(`{3,}|~{3,})[ \t]*(.*)$/;

export function matchCodeFenceOpen(
  line: string,
): { marker: string; info: string } | undefined {
  const match = FENCE_OPEN_RE.exec(line);
  if (!match) return undefined;
  return { marker: match[1]!, info: (match[2] ?? "").trim() };
}

export function isCodeFenceClose(line: string, marker: string): boolean {
  const match = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  if (!match) return false;
  const run = match[1]!;
  return run[0] === marker[0] && run.length >= marker.length;
}

function looksLikePath(info: string): boolean {
  if (info.includes("/") || info.includes("\\")) return true;
  return /^[\w.-]+\.[A-Za-z][\w]*$/.test(info) && !info.startsWith(".");
}

export function openCodeFence(marker: string, info: string): CodeFenceState {
  const token = (info.split(/[\s,;]+/)[0] ?? "").replace(/^[{"']|["']$/g, "");
  const tag = token.toLowerCase();

  if (looksLikePath(token)) {
    return { marker, label: token, langPath: token, carry: emptyCarry(), pendingBlanks: 0 };
  }
  const extension = INFO_EXTENSION[tag] ?? tag;
  return {
    marker,
    label: INFO_LABEL[tag] ?? (tag || "code"),
    langPath: extension ? `code.${extension}` : "code.txt",
    carry: emptyCarry(),
    pendingBlanks: 0,
  };
}

export function codeBlockWidth(wrapWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(Math.floor(wrapWidth), MAX_WIDTH));
}

export function trimCodeBlockBody(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]!.trim().length === 0) start += 1;
  while (end > start && lines[end - 1]!.trim().length === 0) end -= 1;
  return lines.slice(start, end);
}

export function codeBlockFitWidth(
  lines: readonly string[],
  label: string,
  available: number,
): number {
  let widest = 0;
  for (const line of lines) {
    const width = renderColumns(expandTabs(line.replace(/\s+$/, "")));
    if (width > widest) widest = width;
  }
  const labelNeeds = label ? renderColumns(label) + 6 : 0;
  const wanted = Math.max(widest + CODE_BLOCK_CHROME, labelNeeds);
  return codeBlockWidth(Math.min(codeBlockWidth(available), wanted));
}

function rule(count: number): string {
  return "─".repeat(Math.max(0, count));
}

function truncateLabel(label: string, maxWidth: number): string {
  if (maxWidth < 1) return "";
  let text = "";
  let width = 0;
  for (const cluster of graphemes(label)) {
    const clusterWidth = renderColumns(cluster);
    if (width + clusterWidth > maxWidth) break;
    text += cluster;
    width += clusterWidth;
  }
  return text;
}

export function codeBlockTop(label: string, width: number): string {
  const { border, label: paintLabel } = palette();
  const span = codeBlockWidth(width) - 2;
  const room = span - 4;
  const labelWidth = renderColumns(label);
  const text =
    room < 1
      ? ""
      : labelWidth <= room
        ? label
        : `${truncateLabel(label, room - 1)}…`;
  if (!text) return border(`╭${rule(span)}╮`);
  return (
    border("╭─") +
    paintLabel(` ${text} `) +
    border(`${rule(span - 3 - renderColumns(text))}╮`)
  );
}

export function codeBlockBottom(width: number): string {
  return palette().border(`╰${rule(codeBlockWidth(width) - 2)}╯`);
}

export function codeBlockRow(body: string, bodyWidth: number, width: number): string {
  const { border } = palette();
  const inner = codeBlockWidth(width) - CODE_BLOCK_CHROME;
  const pad = " ".repeat(Math.max(0, inner - bodyWidth));
  return `${border("│")} ${body}${pad} ${border("│")}`;
}

interface Cell {
  readonly ch: string;
  readonly kind: SyntaxKind;
  readonly w: number;
}

function graphemes(text: string): string[] {
  return Array.from(
    GRAPHEME_SEGMENTER.segment(text),
    ({ segment }) => segment,
  );
}

function expandTabs(line: string): string {
  if (!line.includes("\t")) return line;
  let out = "";
  let col = 0;
  for (const ch of graphemes(line)) {
    if (ch === "\t") {
      const gap = TAB_WIDTH - (col % TAB_WIDTH);
      out += " ".repeat(gap);
      col += gap;
      continue;
    }
    out += ch;
    col += renderColumns(ch);
  }
  return out;
}

function toCells(spans: readonly SyntaxSpan[]): Cell[] {
  const text = spans.map((span) => span.text).join("");
  const kinds: SyntaxKind[] = [];
  for (const span of spans) {
    for (let i = 0; i < span.text.length; i += 1) kinds.push(span.kind);
  }

  const cells: Cell[] = [];
  for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
    cells.push({
      ch: segment,
      kind: kinds[index] ?? "plain",
      w: renderColumns(segment),
    });
  }
  return cells;
}

function breaksAfter(ch: string): boolean {
  return ch === " " || ",;)]}>".includes(ch);
}

function sliceRows(cells: Cell[], firstBudget: number, restBudget: number): Cell[][] {
  const rows: Cell[][] = [];
  let start = 0;
  while (start < cells.length) {
    const budget = Math.max(1, rows.length === 0 ? firstBudget : restBudget);
    const floor = budget * SOFT_BREAK_FLOOR;
    let used = 0;
    let end = start;
    let soft = -1;
    while (end < cells.length && used + cells[end]!.w <= budget) {
      used += cells[end]!.w;
      end += 1;
      if (used >= floor && breaksAfter(cells[end - 1]!.ch)) soft = end;
    }
    if (end >= cells.length) {
      rows.push(cells.slice(start));
      return rows;
    }
    const cut = soft > start ? soft : Math.max(end, start + 1);
    rows.push(cells.slice(start, cut));
    start = cut;
  }
  return rows.length > 0 ? rows : [[]];
}

function paint(cells: readonly Cell[]): { text: string; width: number } {
  const { syntax } = palette();
  let text = "";
  let width = 0;
  let run = "";
  let kind: SyntaxKind = "plain";
  for (const cell of cells) {
    if (cell.kind !== kind) {
      if (run) text += syntax[kind](run);
      run = "";
      kind = cell.kind;
    }
    run += cell.ch;
    width += cell.w;
  }
  if (run) text += syntax[kind](run);
  return { text, width };
}

function leadingSpaces(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

const ROW_CACHE = new Map<string, { rows: readonly string[]; carry: HighlightCarry }>();
const ROW_CACHE_MAX = 4096;

function carryKey(carry: HighlightCarry): string {
  return `${carry.inBlockComment ? 1 : 0}${carry.inTripleString ? 1 : 0}${carry.tripleQuote ?? ""}`;
}

function snapshotCarry(carry: HighlightCarry): HighlightCarry {
  return {
    inBlockComment: carry.inBlockComment,
    inTripleString: carry.inTripleString,
    tripleQuote: carry.tripleQuote,
  };
}

function restoreCarry(target: HighlightCarry, source: HighlightCarry): void {
  target.inBlockComment = source.inBlockComment;
  target.inTripleString = source.inTripleString;
  target.tripleQuote = source.tripleQuote;
}

function cacheRows(key: string, rows: readonly string[], carry: HighlightCarry): void {
  if (ROW_CACHE.size >= ROW_CACHE_MAX) {
    const oldest = ROW_CACHE.keys().next();
    if (!oldest.done) ROW_CACHE.delete(oldest.value);
  }
  ROW_CACHE.set(key, { rows, carry: snapshotCarry(carry) });
}

export function codeBlockRows(
  source: string,
  fence: CodeFenceState,
  width: number,
): string[] {
  const panel = codeBlockWidth(width);
  const inner = panel - CODE_BLOCK_CHROME;
  const line = expandTabs(source.replace(/\s+$/, ""));

  if (line.length === 0) {
    fence.pendingBlanks += 1;
    return [];
  }

  const rows: string[] = [];
  for (let i = 0; i < fence.pendingBlanks; i += 1) {
    rows.push(codeBlockRow("", 0, panel));
  }
  fence.pendingBlanks = 0;

  const key = `${panel}\u0000${fence.langPath}\u0000${carryKey(fence.carry)}\u0000${line}`;
  const cached = ROW_CACHE.get(key);
  if (cached) {
    restoreCarry(fence.carry, cached.carry);
    rows.push(...cached.rows);
    return rows;
  }

  const cells = toCells(highlightLineForPath(line, fence.langPath, fence.carry));
  const indent = Math.min(
    leadingSpaces(line) + HANGING_INDENT,
    Math.floor(inner / 2),
    Math.max(0, inner - MIN_BODY),
  );
  const hang = " ".repeat(indent);
  const chunks = sliceRows(cells, inner, inner - indent);

  const content = chunks.map((chunk, i) => {
    const { text, width: bodyWidth } = paint(chunk);
    const prefix = i === 0 ? "" : hang;
    return codeBlockRow(prefix + text, prefix.length + bodyWidth, panel);
  });
  cacheRows(key, content, fence.carry);
  rows.push(...content);
  return rows;
}
