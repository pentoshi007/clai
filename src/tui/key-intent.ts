/**
 * Composer key-intent helpers.
 *
 * Deciding whether a keypress should insert a newline (vs. submit the prompt)
 * has to work across every OS and terminal, so it can't rely on Shift+Enter:
 * most terminals send a bare CR (`\r`) for Shift+Enter, identical to plain
 * Enter, and the ones that disambiguate use the kitty/CSI-u keyboard protocol
 * which Ink's key parser does not understand (it would surface as garbage
 * text). The reliably-detectable, cross-platform newline keys are:
 *
 *   - Ctrl+J — the raw line-feed control code (U+000A). Every terminal on
 *     macOS, Linux and Windows sends it, and Ink reports it as ch="\n" with
 *     no ctrl flag (name "enter", distinct from Enter's name "return").
 *   - Alt/Option+Enter — sent as ESC+CR; Ink strips the ESC and delivers a
 *     bare "\r" with key.return === false, so it is distinguishable from a
 *     submitting Enter (which always arrives with key.return === true).
 *   - Shift+Enter / Meta+Enter — honoured too, for the minority of terminals
 *     that DO report the modifier alongside Return.
 */

export interface KeyLike {
  return?: boolean;
  shift?: boolean;
  meta?: boolean;
  ctrl?: boolean;
}

/**
 * True when a keypress should insert a newline into the composer instead of
 * submitting. Plain Enter (`\r` with key.return) always submits.
 */
export function isComposerNewline(ch: string, key: KeyLike): boolean {
  // Terminals that report the modifier with Return: Shift+Enter / Meta+Enter.
  if (key.return && (key.shift || key.meta)) return true;
  // Plain Enter submits — never a newline.
  if (key.return) return false;
  // Ctrl+J (line feed) and Alt/Option+Enter (ESC+CR → bare CR without the
  // Return flag) both insert a newline on every OS. Guard against modified
  // control chords so Ctrl+<other> / Meta+<other> don't count.
  if (!key.ctrl && !key.meta && (ch === "\n" || ch === "\r" || ch === "\r\n")) {
    return true;
  }
  return false;
}

/**
 * OS-appropriate hint for the newline key, shown in the composer placeholder.
 * Ctrl+J is the universal fallback that works everywhere; the OS-idiomatic
 * modifier+Enter is listed first where it commonly works.
 */
export function newlineHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case "darwin":
      return "⌥+return or ⌃J for newline";
    case "win32":
      return "alt+enter or ctrl+j for newline";
    default:
      return "alt+enter or ctrl+j for newline";
  }
}
