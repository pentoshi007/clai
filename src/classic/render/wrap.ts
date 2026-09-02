import { graphemes, tokenize, sealStyle } from "./ansi-text.js";
import { layoutWidth } from "./measure.js";

export interface WrapOptions {
  readonly width: number;
  readonly firstPrefix?: string | undefined;
  readonly nextPrefix?: string | undefined;
}

function isBreakable(grapheme: string): boolean {
  return grapheme === " " || grapheme === "\t";
}

export function wrapAnsiLine(text: string, budget: number): string[] {
  if (budget <= 0) return [""];
  if (text.length === 0) return [""];

  const rows: string[] = [];
  let active = "";
  let carried = "";
  let row = "";
  let rowWidth = 0;
  let word = "";
  let wordWidth = 0;

  const flushRow = (): void => {
    rows.push(sealStyle(`${carried}${row.replace(/ +$/, "")}`));
    carried = active;
    row = "";
    rowWidth = 0;
  };

  const commitWord = (): void => {
    row += word;
    rowWidth += wordWidth;
    word = "";
    wordWidth = 0;
  };

  for (const token of tokenize(text)) {
    if (token.kind === "escape") {
      if (token.value.endsWith("m")) {
        const body = token.value.slice(2, -1);
        active = body === "" || body === "0" || body === "00" ? "" : token.value;
      }
      word += token.value;
      continue;
    }
    for (const grapheme of graphemes(token.value)) {
      const width = layoutWidth(grapheme);
      if (isBreakable(grapheme)) {
        if (rowWidth + wordWidth > budget && rowWidth > 0) flushRow();
        commitWord();
        if (rowWidth + width > budget) {
          flushRow();
          continue;
        }
        row += grapheme;
        rowWidth += width;
        continue;
      }
      if (wordWidth + width > budget) {
        if (rowWidth > 0) flushRow();
        commitWord();
        flushRow();
      } else if (rowWidth + wordWidth + width > budget && rowWidth > 0) {
        flushRow();
      }
      word += grapheme;
      wordWidth += width;
    }
  }
  commitWord();
  if (row.length > 0 || rows.length === 0) flushRow();
  return rows;
}

export function wrapWithPrefixes(
  text: string,
  options: WrapOptions,
): string[] {
  const firstPrefix = options.firstPrefix ?? "";
  const nextPrefix = options.nextPrefix ?? firstPrefix;
  const out: string[] = [];
  for (const logical of text.split("\n")) {
    const budget = Math.max(
      1,
      options.width - layoutWidth(out.length === 0 ? firstPrefix : nextPrefix),
    );
    for (const row of wrapAnsiLine(logical, budget)) {
      out.push(`${out.length === 0 ? firstPrefix : nextPrefix}${row}`);
    }
  }
  return out.length > 0 ? out : [firstPrefix];
}

export function reflowRows(rows: readonly string[], budget: number): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (layoutWidth(row) <= budget) {
      out.push(row);
      continue;
    }
    out.push(...wrapAnsiLine(row, Math.max(1, budget)));
  }
  return out;
}
