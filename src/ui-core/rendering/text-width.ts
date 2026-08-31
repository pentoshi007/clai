
import stringWidth from "string-width";

// biome-ignore lint: ANSI escape sequences are intentional.
const SGR = /\x1b\[[0-9;]*m/g;

export function renderColumns(text: string): number {
  if (text.length === 0) return 0;
  const plain = text.includes("\x1b") ? text.replace(SGR, "") : text;
  return Math.max(stringWidth(plain), plain.length);
}
