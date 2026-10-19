import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;
// biome-ignore lint: ESC and C1 controls start sequences that string-width strips as a whole.
const CONTROL_SEQUENCE_START = /[\x1b\x80-\x9f]/;

function printableAscii(code: number): boolean {
  return code >= 0x20 && code < 0x7f;
}

const RUN_CACHE_LIMIT = 8192;
const runWidths = new Map<string, number>();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const joinsFollowing = new Map<number, boolean>();

function joinsFollowingAscii(text: string, end: number): boolean {
  let last = end - 1;
  const code = text.charCodeAt(last);
  if (code >= 0xdc00 && code <= 0xdfff && last > 0) {
    const high = text.charCodeAt(last - 1);
    if (high >= 0xd800 && high <= 0xdbff) last -= 1;
  }
  const point = text.codePointAt(last)!;
  const cached = joinsFollowing.get(point);
  if (cached !== undefined) return cached;
  let segments = 0;
  for (const _ of graphemes.segment(`${String.fromCodePoint(point)}a`)) segments += 1;
  const joins = segments === 1;
  if (joinsFollowing.size >= RUN_CACHE_LIMIT) joinsFollowing.clear();
  joinsFollowing.set(point, joins);
  return joins;
}

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
    for (;;) {
      while (end < length && !printableAscii(plain.charCodeAt(end))) end += 1;
      if (end < length && joinsFollowingAscii(plain, end)) {
        end += 1;
        continue;
      }
      break;
    }
    width += runWidth(plain.slice(start, end));
    index = end;
  }
  return width;
}

export function terminalWidth(text: string): number {
  if (text.length === 0) return 0;
  return CONTROL_SEQUENCE_START.test(text) ? stringWidth(text) : plainWidth(text);
}

export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(terminalWidth(plain), plain.length);
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
