
import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;

export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(stringWidth(plain), plain.length);
}

export function middleClipText(text: string, columns: number): string {
  if (columns < 1) return "";
  if (stringWidth(text) <= columns) return text;
  if (columns === 1) return "…";
  const headBudget = Math.floor((columns - 1) * 0.45);
  const tailBudget = columns - 1 - headBudget;
  const chars = [...text];
  let head = "";
  let tail = "";
  let used = 0;
  for (const char of chars) {
    const width = stringWidth(char);
    if (used + width > headBudget) break;
    head += char;
    used += width;
  }
  used = 0;
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index]!;
    const width = stringWidth(char);
    if (used + width > tailBudget) break;
    tail = char + tail;
    used += width;
  }
  return `${head}…${tail}`;
}
