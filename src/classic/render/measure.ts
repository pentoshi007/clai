import stringWidth from "string-width";
import { renderColumns } from "../../ui-core/rendering/text-width.js";

// biome-ignore lint: ANSI escape sequences are intentional.
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI, "") : text;
}

export function layoutWidth(text: string): number {
  return renderColumns(text);
}

export function displayWidth(text: string): number {
  const plain = stripAnsi(text);
  return plain.length === 0 ? 0 : stringWidth(plain);
}

export function contentWidth(columns: number): number {
  return Math.max(1, Math.floor(columns));
}

export function blockRowCount(lines: readonly string[]): number {
  return lines.length;
}
