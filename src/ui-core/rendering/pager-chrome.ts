
import { renderColumns } from "./text-width.js";

export const PAGER_HELP_FULL =
  "↑↓:scroll  ·  pg↑↓  ·  ^u:top  ·  ^d:bottom  ·  ^r:search  ·  q/esc:close";
export const PAGER_HELP_MED =
  "↑↓:scroll  ·  ^u:top  ·  ^d:bottom  ·  ^r:search  ·  q/esc:close";
export const PAGER_HELP_SHORT =
  "↑↓ · ^u:top · ^d:bottom · ^r:search · q:close";
export const PAGER_HELP_MIN = "^r:search  ·  q/esc:close";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function columns(text: string): number {
  return renderColumns(text);
}


function clipToColumns(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (columns(text) <= maxCols) return text;
  let out = "";
  let used = 0;
  for (const { segment: cluster } of GRAPHEME_SEGMENTER.segment(text)) {
    const width = Math.max(0, columns(cluster));
    if (used + width > maxCols) break;
    out += cluster;
    used += width;
  }
  return out;
}

export function fitOneLine(candidates: readonly string[], maxCols: number): string {
  const budget = Math.max(1, maxCols);
  for (const text of candidates) {
    if (columns(text) <= budget) return text;
  }
  const last = candidates[candidates.length - 1] ?? "";
  if (columns(last) <= budget) return last;
  if (budget <= 1) return "…";
  return `${clipToColumns(last, budget - 1)}…`;
}

export function padChromeRow(left: string, right: string, width: number): string {
  const w = Math.max(1, width);
  if (w < 8) return fitOneLine([left], w);
  const rightBudget = Math.min(
    Math.max(columns(right), 4),
    Math.max(8, Math.floor(w * 0.4)),
  );
  const r = fitOneLine(
    [right, right.replace(/\s*·\s*.*$/, ""), right.replace(/\D/g, "") || "·"],
    rightBudget,
  );
  const rightWidth = columns(r);
  const leftBudget = Math.max(1, w - rightWidth - 1);
  const l = fitOneLine([left], leftBudget);
  const gap = Math.max(1, w - columns(l) - rightWidth);
  const row = `${l}${" ".repeat(gap)}${r}`;
  const rowWidth = columns(row);
  if (rowWidth === w) return row;
  if (rowWidth > w) return clipToColumns(row, w);
  return row + " ".repeat(w - rowWidth);
}

export function centerChromeRow(text: string, width: number): string {
  const budget = Math.max(1, width);
  const fitted = fitOneLine([text], budget);
  const space = Math.max(0, budget - columns(fitted));
  const left = Math.floor(space / 2);
  return `${" ".repeat(left)}${fitted}${" ".repeat(space - left)}`;
}

function wrapBoundary(lastSpace: number, length: number, width: number): number {
  const afterSpace = lastSpace + 1;
  return afterSpace >= Math.max(1, Math.floor(width * 0.35)) ? afterSpace : length;
}

function* asciiRows(line: string, width: number, preserve: boolean): Generator<string> {
  let start = 0;
  while (start + width < line.length) {
    const piece = line.slice(start, start + width);
    const cut = wrapBoundary(piece.lastIndexOf(" "), width, width);
    const row = piece.slice(0, cut);
    yield preserve ? row : row.trimEnd();
    start += cut;
    if (!preserve) while (line[start] === " ") start++;
  }
  if (start < line.length) yield line.slice(start);
}

function* unicodeRows(line: string, width: number, preserve: boolean): Generator<string> {
  let cells: string[] = [];
  let used = 0;
  let skipSpaces = false;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(line)) {
    const size = columns(segment);
    while (cells.length && used + size > width) {
      const cut = wrapBoundary(cells.lastIndexOf(" "), cells.length, width);
      const row = cells.slice(0, cut).join("");
      yield preserve ? row : row.trimEnd();
      cells = cells.slice(cut);
      used = cells.reduce((sum, cell) => sum + columns(cell), 0);
      skipSpaces = !preserve && cells.length === 0;
    }
    if (skipSpaces && segment === " ") continue;
    skipSpaces = false;
    cells.push(segment);
    used += size;
  }
  if (cells.length) yield cells.join("");
}

function pagerRows(line: string, width: number, preserve: boolean): Generator<string> {
  const max = Math.max(1, Math.floor(width));
  return /^[\x20-\x7e]*$/.test(line) ? asciiRows(line, max, preserve) : unicodeRows(line, max, preserve);
}

export function firstPagerRow(line: string, width: number): string {
  return pagerRows(line, width, true).next().value ?? " ";
}

export function wrapPagerLine(
  line: string,
  width: number,
  options: { preserveWhitespace?: boolean } = {},
): string[] {
  if (!line) return [" "];
  if (line.length <= width && columns(line) <= width) return [line];
  return Array.from(pagerRows(line, width, options.preserveWhitespace ?? false));
}
