
import { normalizeChord, type KeyEventLike } from "../../ui-core/actions/chord.js";

export type { KeyEventLike };

const ENTER_NAMES = new Set(["return", "kpenter"]);

function baseKeyName(name: string): string {
  if (name === "linefeed") return "j";
  if (ENTER_NAMES.has(name)) return "enter";
  return name;
}

export function chordFromKeyEvent(key: KeyEventLike): string {
  const isLinefeed = key.name === "linefeed";
  const isBacktab = key.name === "backtab";
  const ctrl = key.ctrl || isLinefeed;
  const alt = Boolean(key.option || key.meta);
  const isUpper = key.name.length === 1 && key.name >= "A" && key.name <= "Z";
  const hasShiftSequence =
    typeof key.sequence === "string" &&
    key.sequence.length === 1 &&
    key.sequence >= "A" &&
    key.sequence <= "Z";
  const shift = Boolean(key.shift) || isBacktab || isUpper || hasShiftSequence;
  const meta = Boolean(key.super);

  const parts: string[] = [];
  if (ctrl) parts.push("ctrl");
  if (alt) parts.push("alt");
  if (shift) parts.push("shift");
  if (meta) parts.push("meta");
  parts.push(isBacktab ? "tab" : baseKeyName(key.name).toLowerCase());

  return normalizeChord(parts.join("+"));
}
