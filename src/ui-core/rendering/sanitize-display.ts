
const ANSI_ESCAPE_RE =
  /\x1b(?:\[<[0-9;]*[Mm]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|P[^\x1b]*(?:\x1b\\)?|[@-Z\\_])/g;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, "");
}

export function sanitizeDisplayText(text: string): string {
  return stripControlChars(stripAnsiSequences(text));
}
