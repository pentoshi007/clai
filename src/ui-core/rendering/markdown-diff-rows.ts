import type { ChalkInstance } from "chalk";
import { nearestAnsi16, nearestAnsi256 } from "./ansi-palette.js";
import { expandTabs, parseModalDiffLine, sliceSpans, syntaxColor, type ParsedDiffLine } from "./file-diff-view.js";
import { wrapPagerLine } from "./pager-chrome.js";
import { emptyCarry, highlightLineForPath, type HighlightCarry, type SyntaxSpan } from "./syntax-highlight.js";
import { renderColumns } from "./text-width.js";
import type { Theme } from "./theme.js";

const TAB_WIDTH = 4;
const HIGHLIGHT_LINE_LIMIT = 5_000;
const BARE_RULE = /^[\d ]{0,8} │\s*$/;
const HEADER_PATH = /^(?:create|edit|overwrite|append|delete) · (.+)$/;

export interface DiffRowState {
  path: string | undefined;
  carry: HighlightCarry;
  highlighted: number;
}

export function emptyDiffRowState(): DiffRowState {
  return { path: undefined, carry: emptyCarry(), highlighted: 0 };
}

export function diffHeaderPath(parsed: ParsedDiffLine): string | undefined {
  return parsed.tone === "header" ? HEADER_PATH.exec(parsed.code)?.[1] : undefined;
}

type Paint = (text: string) => string;

function foreground(paint: ChalkInstance, color: string): ChalkInstance {
  if (paint.level >= 3) return paint.hex(color);
  if (paint.level === 2) return paint.ansi256(nearestAnsi256(color));
  return paint[nearestAnsi16(color)];
}

function background(paint: ChalkInstance, color: string): Paint {
  if (paint.level >= 3) return paint.bgHex(color);
  return paint.bgAnsi256(nearestAnsi256(color, true));
}

function toneColors(parsed: ParsedDiffLine, theme: Theme): { rail: string; mark: string; wash: string | undefined } {
  if (parsed.tone === "add") return { rail: theme.diffAdd, mark: theme.diffAdd, wash: theme.diffAddBg };
  if (parsed.tone === "del") return { rail: theme.diffDel, mark: theme.diffDel, wash: theme.diffDelBg };
  return { rail: theme.diffGutter, mark: theme.muted, wash: undefined };
}

function paintCode(paint: ChalkInstance, theme: Theme, parsed: ParsedDiffLine, chunk: string, spans: readonly SyntaxSpan[] | undefined): string {
  if (parsed.tone === "header") return foreground(paint, theme.muted)(chunk);
  if (!spans?.length) return foreground(paint, theme.foreground)(chunk);
  let out = "";
  for (const span of spans) out += foreground(paint, syntaxColor(span.kind, theme))(span.text);
  return out;
}

export function diffMarkdownRows(
  line: string,
  width: number,
  state: DiffRowState,
  paint: ChalkInstance,
  theme: Theme,
): string[] | undefined {
  const parsed = parseModalDiffLine(BARE_RULE.test(line) ? `${line.trimEnd()} ` : line);
  if (!parsed) return undefined;
  const headerPath = diffHeaderPath(parsed);
  if (headerPath) {
    state.path = headerPath;
    state.carry = emptyCarry();
  }
  const header = parsed.tone === "header";
  const code = expandTabs(parsed.code, TAB_WIDTH);
  const lead = parsed.gutter.length + 3 + (header ? 0 : 2);
  const chunks = wrapPagerLine(code, Math.max(1, width - lead), { preserveWhitespace: true });
  const path = !header && paint.level > 0 && state.highlighted < HIGHLIGHT_LINE_LIMIT ? state.path : undefined;
  const spans = path ? highlightLineForPath(code, path, state.carry) : undefined;
  if (spans) state.highlighted += 1;
  const colors = toneColors(parsed, theme);
  const wash = paint.level >= 2 ? colors.wash : undefined;
  const mark = parsed.tone === "add" ? "+" : parsed.tone === "del" ? "-" : " ";
  const blank = " ".repeat(parsed.gutter.length);
  const rows: string[] = [];
  let offset = 0;
  chunks.forEach((chunk, part) => {
    const gutter = part === 0 ? parsed.gutter : blank;
    const rowMark = part === 0 ? mark : " ";
    const rule = `${foreground(paint, theme.diffGutter)(`${gutter} `)}${foreground(paint, colors.rail)("│ ")}`;
    const marked = header ? rule : `${rule}${rowMark === " " ? "  " : foreground(paint.bold, colors.mark)(`${rowMark} `)}`;
    const slice = spans ? sliceSpans(spans, offset, offset + chunk.length) : undefined;
    const row = `${marked}${paintCode(paint, theme, parsed, chunk, slice)}`;
    offset += chunk.length;
    if (!wash) {
      rows.push(row);
      return;
    }
    const used = renderColumns(`${gutter} │ ${header ? "" : "  "}${chunk}`);
    rows.push(background(paint, wash)(`${row}${" ".repeat(Math.max(0, width - used))}`));
  });
  return rows;
}
