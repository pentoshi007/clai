import type { PagerMatch } from "../../../ui-core/state/pager-search.js";
import { wrapPagerLine } from "../../../ui-core/rendering/pager-chrome.js";
import {
  emptyCarry,
  highlightLineForPath,
  type SyntaxSpan,
} from "../../../ui-core/rendering/syntax-highlight.js";
import type { preparePagerDisplay } from "../../rendering/pager-markdown.js";
import { parseDiffLine } from "./pager-line.js";

type PagerDisplay = ReturnType<typeof preparePagerDisplay>;

export type PagerRowKind = "markdown" | "diff" | "subagent" | "plain";

export interface PagerRow {
  readonly key: string;
  readonly index: number;
  readonly line: string;
  readonly kind: PagerRowKind;
  readonly textOffset?: number | undefined;
  readonly spans?: readonly SyntaxSpan[] | undefined;
}

export interface LineSearch {
  readonly matches: readonly PagerMatch[];
  readonly active: number;
}

export const NO_MATCHES: readonly PagerMatch[] = [];

export function buildPagerRows(input: {
  readonly display: PagerDisplay;
  readonly lines: readonly string[];
  readonly contentCols: number;
  readonly useDiffGutters: boolean;
  readonly isSubagent: boolean;
  readonly highlightPath: string;
  readonly wrapRows?: boolean | undefined;
}): PagerRow[] {
  const { display, lines, contentCols, useDiffGutters, isSubagent, highlightPath } = input;
  const rows: PagerRow[] = [];
  const carry = emptyCarry();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (display.mode === "markdown") {
      let textOffset = 0;
      const chunks = input.wrapRows ? wrapPagerLine(line, contentCols, { preserveWhitespace: true }) : [line];
      chunks.forEach((chunk, part) => {
        rows.push({ key: `md-${index}-${part}`, index, line: chunk, kind: "markdown", textOffset });
        textOffset += chunk.length;
      });
      continue;
    }
    const parsed = useDiffGutters ? parseDiffLine(line) : null;
    if (parsed) {
      const chunks = wrapPagerLine(
        parsed.code,
        Math.max(1, contentCols - (parsed.gutter.length + 3)),
        { preserveWhitespace: true },
      );
      const mark = parsed.tone === "add" ? "+" : parsed.tone === "del" ? "−" : " ";
      chunks.forEach((chunk, part) => {
        const gutter = part === 0 ? parsed.gutter : " ".repeat(parsed.gutter.length);
        const header = parsed.tone === "header";
        rows.push({
          key: `${index}-${part}`,
          index,
          line: header ? `${gutter} │ ${chunk}` : `${gutter} │ ${mark} ${chunk}`,
          kind: "diff",
          spans: header
            ? [{ kind: "plain", text: chunk }]
            : highlightLineForPath(chunk, highlightPath, carry),
        });
      });
      continue;
    }
    if (isSubagent && !useDiffGutters) {
      let textOffset = 0;
      const chunks = input.wrapRows ? wrapPagerLine(line, contentCols, { preserveWhitespace: true }) : [line];
      chunks.forEach((chunk, part) => {
        rows.push({ key: `${index}-${part}`, index, line: chunk, kind: "subagent", textOffset });
        textOffset += chunk.length;
      });
      continue;
    }
    wrapPagerLine(line, contentCols, { preserveWhitespace: true }).forEach((chunk, part) => {
      rows.push({ key: `${index}-${part}`, index, line: chunk, kind: "plain" });
    });
  }
  return rows;
}

export function slicePagerSpans<T extends { readonly text: string }>(
  spans: readonly T[],
  start: number,
  length: number,
): T[] {
  const result: T[] = [];
  let offset = 0;
  const end = start + length;
  for (const span of spans) {
    const next = offset + span.text.length;
    if (next > start && offset < end) {
      result.push({
        ...span,
        text: span.text.slice(Math.max(0, start - offset), Math.min(span.text.length, end - offset)),
      });
    }
    offset = next;
    if (offset >= end) break;
  }
  return result;
}

export function pagerRowWindow(count: number, top: number, height: number): { start: number; end: number } {
  const viewport = Math.max(1, Math.floor(height));
  const overscan = Math.max(16, viewport);
  const first = Math.max(0, Math.min(Math.floor(top), Math.max(0, count - viewport)));
  return { start: Math.max(0, first - overscan), end: Math.min(count, first + viewport + overscan) };
}

export function pagerRowSearch(search: LineSearch | undefined, offset: number, length: number): LineSearch {
  if (!search) return { matches: NO_MATCHES, active: -1 };
  const visible = search.matches.filter((match) => match.column < offset + length && match.column + match.length > offset);
  const active = search.matches[search.active];
  return {
    matches: visible.map((match) => {
      const column = Math.max(0, match.column - offset);
      const end = Math.min(length, match.column + match.length - offset);
      return { ...match, column, length: end - column };
    }),
    active: active ? visible.indexOf(active) : -1,
  };
}

export function groupPagerMatches(
  matches: readonly PagerMatch[],
  activeMatchIndex: number,
): ReadonlyMap<number, LineSearch> {
  const grouped = new Map<number, { matches: PagerMatch[]; start: number }>();
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const group = grouped.get(match.line);
    if (group) group.matches.push(match);
    else grouped.set(match.line, { matches: [match], start: index });
  }
  const active = matches[activeMatchIndex]?.line;
  const result = new Map<number, LineSearch>();
  for (const [line, group] of grouped) {
    result.set(line, {
      matches: group.matches,
      active: line === active ? activeMatchIndex - group.start : -1,
    });
  }
  return result;
}
