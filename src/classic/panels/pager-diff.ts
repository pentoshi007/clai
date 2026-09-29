import {
  expandTabs,
  parseModalDiffLine,
  sliceSpans,
  syntaxColor,
  type ParsedDiffLine,
} from "../../ui-core/rendering/file-diff-view.js";
import { wrapPagerLine } from "../../ui-core/rendering/pager-chrome.js";
import {
  emptyCarry,
  highlightLineForPath,
  type HighlightCarry,
  type SyntaxSpan,
} from "../../ui-core/rendering/syntax-highlight.js";
import { sealStyle } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";

export interface PagerDiffOptions {
  readonly path: string;
  readonly ink?: InkTheme | undefined;
}

const TAB_WIDTH = 4;
const HIGHLIGHT_LINE_LIMIT = 5_000;
const MIN_DIFF_WIDTH = 16;
const BARE_RULE = /^[\d ]{0,8} │\s*$/;

function markFor(parsed: ParsedDiffLine, unicode: boolean): string {
  if (parsed.tone === "add") return "+";
  if (parsed.tone === "del") return unicode ? "−" : "-";
  return " ";
}

function washFor(parsed: ParsedDiffLine): ThemeToken | undefined {
  if (parsed.tone === "add") return "diffAddBg";
  if (parsed.tone === "del") return "diffDelBg";
  return undefined;
}

function paintCode(
  ink: InkTheme,
  parsed: ParsedDiffLine,
  chunk: string,
  spans: readonly SyntaxSpan[],
): string {
  if (parsed.tone === "header") return ink.fg("muted", chunk);
  if (!ink.richColor && parsed.tone !== "context") {
    return ink.fg(parsed.tone === "add" ? "diffAdd" : "diffDel", chunk);
  }
  if (spans.length === 0) return ink.fg("foreground", chunk);
  let out = "";
  for (const span of spans) out += ink.hex(syntaxColor(span.kind, ink.theme), span.text);
  return out;
}

function paintRow(
  ink: InkTheme,
  parsed: ParsedDiffLine,
  gutter: string,
  mark: string,
  chunk: string,
  spans: readonly SyntaxSpan[],
  width: number,
): string {
  const rule = ink.fg("diffGutter", `${gutter} ${ink.glyphs.boxVertical} `);
  const markTone: ThemeToken = parsed.tone === "add" ? "diffAdd" : parsed.tone === "del" ? "diffDel" : "muted";
  const head = parsed.tone === "header" ? rule : `${rule}${ink.style(`${mark} `, { fg: markTone, bold: mark.trim() !== "" })}`;
  const line = `${head}${paintCode(ink, parsed, chunk, spans)}`;
  const wash = ink.richColor ? washFor(parsed) : undefined;
  return wash ? ink.band(line, width, { bg: wash }) : sealStyle(line);
}

function diffRows(
  parsed: ParsedDiffLine,
  width: number,
  options: PagerDiffOptions,
  carry: HighlightCarry,
  highlight: boolean,
): string[] {
  const ink = options.ink;
  const unicode = ink?.unicode ?? true;
  const rule = unicode ? "│" : "|";
  const code = expandTabs(parsed.code, TAB_WIDTH);
  const header = parsed.tone === "header";
  const mark = markFor(parsed, unicode);
  const lead = parsed.gutter.length + 3 + (header ? 0 : 2);
  const chunks = wrapPagerLine(code, Math.max(1, width - lead), { preserveWhitespace: true });
  const spans = ink && highlight && !header && ink.colorMode !== "none"
    ? highlightLineForPath(code, options.path, carry)
    : undefined;
  const blank = " ".repeat(parsed.gutter.length);
  const rows: string[] = [];
  let offset = 0;
  chunks.forEach((chunk, part) => {
    const gutter = part === 0 ? parsed.gutter : blank;
    const rowMark = part === 0 ? mark : " ";
    const end = offset + chunk.length;
    if (!ink) {
      rows.push(header ? `${gutter} ${rule} ${chunk}` : `${gutter} ${rule} ${rowMark} ${chunk}`);
    } else {
      const slice = spans ? sliceSpans(spans, offset, end) : [];
      rows.push(paintRow(ink, parsed, gutter, rowMark, chunk, slice, width));
    }
    offset = end;
  });
  return rows;
}

export function diffPagerLines(
  logical: readonly string[],
  width: number,
  options: PagerDiffOptions,
): readonly string[] | undefined {
  if (width < MIN_DIFF_WIDTH) return undefined;
  const carry = emptyCarry();
  const out: string[] = [];
  let matched = 0;
  logical.forEach((line, index) => {
    const parsed = parseModalDiffLine(BARE_RULE.test(line) ? `${line.trimEnd()} ` : line);
    if (!parsed) {
      out.push(...wrapPagerLine(line, width, { preserveWhitespace: true }));
      return;
    }
    matched += 1;
    out.push(...diffRows(parsed, width, options, carry, index < HIGHLIGHT_LINE_LIMIT));
  });
  return matched > 0 ? out : undefined;
}
