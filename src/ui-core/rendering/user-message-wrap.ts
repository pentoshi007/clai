
import { wrapPlainString } from "./text-format.js";

export const USER_MESSAGE_CHROME_COLS = 10;

export function wrapUserPrompt(
  text: string,
  contentWidth: number,
  chromeCols = USER_MESSAGE_CHROME_COLS,
): string[] {
  const wrapWidth = Math.max(12, contentWidth - chromeCols);
  return wrapPlainString(text, wrapWidth).map((line) => line.lineText);
}
