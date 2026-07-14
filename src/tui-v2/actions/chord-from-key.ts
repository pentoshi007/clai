/**
 * Bridges a terminal key event into our normalized chord vocabulary (V2-040).
 *
 * Renderer-independent by design: it takes a plain object shaped like
 * OpenTUI's `KeyEvent` rather than importing `@opentui/core`, so the mapping
 * is unit-testable and the renderer adapter (`composer-editor.tsx`) supplies
 * the real event. Two decisions are protocol-specific and documented here
 * rather than left implicit:
 *
 *  - OpenTUI reports Option/Alt as `option` and/or `meta` depending on the
 *    terminal; both map to our "alt" modifier. `super` (Cmd/Win) maps to our
 *    "meta" modifier, since nothing in the default keymap uses it otherwise.
 *  - Ctrl+J commonly arrives as a bare linefeed byte (`name: "linefeed"`,
 *    no modifier flags) rather than `{name: "j", ctrl: true}`. It is
 *    normalized to the "ctrl+j" chord so the global jobs binding matches
 *    regardless of which form the terminal sends.
 */

import { normalizeChord } from "./keymap.js";

export interface KeyEventLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
}

const ENTER_NAMES = new Set(["return", "kpenter"]);

function baseKeyName(name: string): string {
  if (name === "linefeed") return "j";
  if (ENTER_NAMES.has(name)) return "enter";
  return name;
}

export function chordFromKeyEvent(key: KeyEventLike): string {
  const isLinefeed = key.name === "linefeed";
  const ctrl = key.ctrl || isLinefeed;
  const alt = Boolean(key.option || key.meta);
  const shift = Boolean(key.shift);
  const meta = Boolean(key.super);

  const parts: string[] = [];
  if (ctrl) parts.push("ctrl");
  if (alt) parts.push("alt");
  if (shift) parts.push("shift");
  if (meta) parts.push("meta");
  parts.push(baseKeyName(key.name));

  return normalizeChord(parts.join("+"));
}
