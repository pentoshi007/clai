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
}): PagerRow[] {
  const { display, lines, contentCols, useDiffGutters, isSubagent, highlightPath } = input;
  const rows: PagerRow[] = [];
  const carry = emptyCarry();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (display.mode === "markdown") {
      rows.push({ key: `md-${index}-0`, index, line, kind: "markdown" });
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
      rows.push({ key: `${index}-0`, index, line, kind: "subagent" });
      continue;
    }
    wrapPagerLine(line, contentCols, { preserveWhitespace: true }).forEach((chunk, part) => {
      rows.push({ key: `${index}-${part}`, index, line: chunk, kind: "plain" });
    });
  }
  return rows;
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
