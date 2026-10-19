import { stripVTControlCharacters } from "node:util";
import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;

function printableAscii(code: number): boolean {
  return code >= 0x20 && code < 0x7f;
}

const RUN_CACHE_LIMIT = 8192;
const runWidths = new Map<string, number>();

function runWidth(run: string): number {
  const cached = runWidths.get(run);
  if (cached !== undefined) return cached;
  const width = stringWidth(run);
  if (run.length <= 64) {
    if (runWidths.size >= RUN_CACHE_LIMIT) runWidths.clear();
    runWidths.set(run, width);
  }
  return width;
}

function plainWidth(plain: string): number {
  const length = plain.length;
  let width = 0;
  let index = 0;
  while (index < length) {
    if (printableAscii(plain.charCodeAt(index))) {
      width += 1;
      index += 1;
      continue;
    }
    let start = index;
    if (start > 0 && printableAscii(plain.charCodeAt(start - 1))) {
      start -= 1;
      width -= 1;
    }
    let end = index + 1;
    while (end < length && !printableAscii(plain.charCodeAt(end))) end += 1;
    width += runWidth(plain.slice(start, end));
    index = end;
  }
  return width;
}

export function terminalWidth(text: string): number {
  if (text.length === 0) return 0;
  return plainWidth(text.includes("\x1b") ? stripVTControlCharacters(text) : text);
}

export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(plain.includes("\x1b") ? stringWidth(plain) : plainWidth(plain), plain.length);
}

export function middleClipText(text: string, columns: number): string {
  if (columns < 1) return "";
  if (terminalWidth(text) <= columns) return text;
  if (columns === 1) return "…";
  const headBudget = Math.floor((columns - 1) * 0.45);
  const tailBudget = columns - 1 - headBudget;
  const chars = [...text];
  let head = "";
  let tail = "";
  let used = 0;
  for (const char of chars) {
    const width = terminalWidth(char);
    if (used + width > headBudget) break;
    head += char;
    used += width;
  }
  used = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const width = terminalWidth(char);
    if (used + width > tailBudget) break;
    tail = char + tail;
    used += width;
  }
  return `${head}…${tail}`;
}
