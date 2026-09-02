
import { wrapPagerLine } from "./pager-chrome.js";

export function preparePromptPreview(
  text: string,
  maxCols: number,
  maxLines: number,
): { lines: string[]; truncated: boolean; totalLines: number } {
  const cols = Math.max(8, maxCols);
  const budget = Math.max(3, maxLines);
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rawLines = source.split("\n");
  const wrapped: string[] = [];
  for (const line of rawLines) {
    for (const part of wrapPagerLine(line, cols)) {
      wrapped.push(part);
    }
  }
  const totalLines = wrapped.length;
  if (totalLines <= budget) {
    return {
      lines: wrapped.length > 0 ? wrapped : [" "],
      truncated: false,
      totalLines,
    };
  }
  const kept = wrapped.slice(0, budget);
  const last = kept[kept.length - 1] ?? "";
  kept[kept.length - 1] =
    last.length > 1 ? `${last.slice(0, Math.max(1, last.length - 1))}…` : "…";
  return { lines: kept, truncated: true, totalLines };
}
