import { matchCodeFenceOpen } from "../code-block.js";
import { backtickRunEnd, isEscapedAt, matchCodeSpan } from "./code-spans.js";

type ColumnAlign = "left" | "center" | "right";

export interface TableHeader {
  readonly cells: readonly string[];
  readonly aligns: readonly ColumnAlign[];
}

const BLOCK_START = /^(?:#{1,6}(?:[ \t]|$)|>|(?:[-*+]|\d+[.)])[ \t])/;
const ALIGNMENT_CELL = /^:?-+:?$/;

function unescapePipes(cell: string): string {
  return cell.replace(/(\\+)\|/g, (match, slashes: string) =>
    slashes.length % 2 === 1 ? `${slashes.slice(1)}|` : match,
  );
}

function splitCells(row: string): string[] | undefined {
  const cells: string[] = [];
  let start = 0;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "`" && !isEscapedAt(row, index)) {
      const openEnd = backtickRunEnd(row, index);
      index = (matchCodeSpan(row, index, openEnd)?.end ?? openEnd) - 1;
      continue;
    }
    if (row[index] !== "|" || isEscapedAt(row, index)) continue;
    if (index > 0) cells.push(unescapePipes(row.slice(start, index).trim()));
    start = index + 1;
  }

  if (start === 0) return undefined;
  if (start < row.length) cells.push(unescapePipes(row.slice(start).trim()));
  return cells.length > 0 ? cells : undefined;
}

export function parseTableRow(line: string): string[] | undefined {
  if (!line.includes("|")) return undefined;
  const row = line.trim();
  if (BLOCK_START.test(row) || matchCodeFenceOpen(row)) return undefined;
  return splitCells(row);
}

export function matchTableHeader(
  cells: readonly string[] | undefined,
  separator: string,
): TableHeader | undefined {
  if (!cells || !/^[ |:\t\r-]+$/.test(separator)) return undefined;
  const trimmed = separator.trim();
  const markers = splitCells(trimmed) ?? [trimmed];
  if (markers.length !== cells.length || !markers.every((marker) => ALIGNMENT_CELL.test(marker))) {
    return undefined;
  }
  const aligns = markers.map((marker): ColumnAlign => {
    if (!marker.endsWith(":")) return "left";
    return marker.startsWith(":") ? "center" : "right";
  });
  return { cells, aligns };
}

export function hasMarkdownTable(text: string): boolean {
  if (!text.includes("|") || !text.includes("-")) return false;
  let previous: string[] | undefined;
  for (const line of text.split("\n")) {
    if (matchTableHeader(previous, line)) return true;
    previous = parseTableRow(line);
  }
  return false;
}
