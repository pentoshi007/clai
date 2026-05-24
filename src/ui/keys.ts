/**
 * Canonical keypress shapes used by clai. Centralized so the REPL,
 * one-shot mode, and tests agree on what counts as "Ctrl+O" / "Ctrl+T" /
 * "Ctrl+C" / "ESC" regardless of platform.
 *
 * Node's `readline.emitKeypressEvents` already normalizes the most
 * common combinations across macOS / Linux / Windows terminals into the
 * same `{ ctrl, meta, name, sequence }` shape, so we just need to be
 * explicit about which fields matter.
 */
export interface Keypress {
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  shift?: boolean | undefined;
  name?: string | undefined;
  sequence?: string | undefined;
}

export function isCtrlC(key: Keypress): boolean {
  return Boolean(key.ctrl) && key.name === "c";
}

export function isCtrlT(key: Keypress): boolean {
  return Boolean(key.ctrl) && key.name === "t";
}

export function isCtrlO(key: Keypress): boolean {
  return Boolean(key.ctrl) && key.name === "o";
}

export function isEscape(key: Keypress): boolean {
  return key.name === "escape";
}
