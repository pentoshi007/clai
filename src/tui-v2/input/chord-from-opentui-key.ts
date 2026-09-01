import { normalizeChord, type KeyEventLike } from "../../ui-core/actions/chord.js";

export type { KeyEventLike };

const ENTER_NAMES = new Set(["return", "kpenter"]);

function isEscapeKey(key: KeyEventLike): boolean {
  const name = key.name.toLowerCase();
  return (
    name === "escape" ||
    name === "esc" ||
    key.name === "\x1b" ||
    key.sequence === "\x1b" ||
    key.raw === "\x1b"
  );
}

function baseKeyName(key: KeyEventLike): string {
  if (isEscapeKey(key)) return "escape";
  if (key.name === "linefeed") return "j";
  if (ENTER_NAMES.has(key.name)) return "enter";
  return key.name;
}

export function isKeyEventRelease(key: KeyEventLike): boolean {
  return key.eventType === "release";
}

export function isKeyEventRepeat(key: KeyEventLike): boolean {
  return key.eventType === "repeat" || key.repeated === true;
}

export function consumeCancellationKeyRepeat(
  key: KeyEventLike & {
    preventDefault(): void;
    stopPropagation?(): void;
  },
  chord: string,
): boolean {
  if (
    (chord !== "escape" && chord !== "ctrl+c") ||
    !isKeyEventRepeat(key)
  ) {
    return false;
  }
  key.preventDefault();
  key.stopPropagation?.();
  return true;
}

export function chordFromKeyEvent(key: KeyEventLike): string {
  const isLinefeed = key.name === "linefeed";
  const isBacktab = key.name === "backtab";
  const ctrl = key.ctrl || isLinefeed;
  const alt = Boolean(key.option || key.meta);
  const baseName = isBacktab ? "tab" : baseKeyName(key);
  const isUpper =
    baseName.length === 1 && baseName >= "A" && baseName <= "Z";
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
  parts.push(baseName.toLowerCase());

  return normalizeChord(parts.join("+"));
}
