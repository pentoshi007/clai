export function normalizePasteLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}
