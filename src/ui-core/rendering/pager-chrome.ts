
import { renderColumns } from "./text-width.js";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function columns(text: string): number {
  return renderColumns(text);
}

function graphemes(text: string): string[] {
  return Array.from(GRAPHEME_SEGMENTER.segment(text), ({ segment }) => segment);
}

function clipToColumns(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (columns(text) <= maxCols) return text;
  let out = "";
  let used = 0;
  for (const cluster of graphemes(text)) {
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
  const w = Math.max(8, width);
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

export function wrapPagerLine(line: string, width: number): string[] {
  const max = Math.max(1, width);
  if (!line) return [" "];
  if (columns(line) <= max) return [line];

  const cells = graphemes(line).map((ch) => ({
    ch,
    w: Math.max(0, columns(ch)),
  }));
  const minBreak = Math.floor(max * 0.35);
  const out: string[] = [];
  let start = 0;

  while (start < cells.length) {
    let used = 0;
    let end = start;
    let space = -1;
    while (end < cells.length && used + cells[end]!.w <= max) {
      used += cells[end]!.w;
      end += 1;
      if (cells[end - 1]!.ch === " ") space = end;
    }
    if (end >= cells.length) {
      out.push(cells.slice(start).map((c) => c.ch).join(""));
      break;
    }
    const cut =
      space > start && space - start >= minBreak ? space : Math.max(end, start + 1);
    out.push(
      cells
        .slice(start, cut)
        .map((c) => c.ch)
        .join("")
        .replace(/\s+$/, ""),
    );
    start = cut;
    while (start < cells.length && cells[start]!.ch === " ") start += 1;
  }

  return out.length > 0 ? out : [" "];
}
