/**
 * Display-safe text sanitization (QUALITY visual correctness / V2-094).
 *
 * External content (tool output, model text, paste) can carry C0/C1 controls
 * and OSC/CSI sequences that corrupt a terminal or inject misleading UI.
 * This pure helper strips those bytes while preserving ordinary newlines,
 * tabs, and Unicode. Clipboard/export paths should run content through here
 * before writing terminal-facing strings.
 */

// CSI / OSC / DCS first (order matters: bare ESC+letter must not swallow `]`).
const ANSI_ESCAPE_RE =
  /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|P[^\x1b]*(?:\x1b\\)?|[@-Z\\_])/g;
// C0 controls except TAB (0x09) and LF (0x0a); DEL; C1 0x80–0x9f.
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f\x80-\x9f]/g;

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, "");
}

/** Full display sanitize: ANSI first, then remaining control characters. */
export function sanitizeDisplayText(text: string): string {
  return stripControlChars(stripAnsiSequences(text));
}
