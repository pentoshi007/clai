import { chordFrom } from "../../ui-core/actions/chord.js";
import type { KeyEvent } from "./key-event.js";

const ENTER_NAMES = new Set(["return", "kpenter", "enter"]);

export function chordFromKey(key: KeyEvent): string {
  const isLinefeed = key.name === "linefeed";
  const isBacktab = key.name === "backtab";
  const isUpper = key.name.length === 1 && key.name >= "A" && key.name <= "Z";
  const name = isLinefeed
    ? "j"
    : isBacktab
      ? "tab"
      : ENTER_NAMES.has(key.name)
        ? "enter"
        : key.name.toLowerCase();

  return chordFrom(
    {
      ctrl: key.ctrl || isLinefeed,
      alt: key.alt,
      shift: key.shift || isBacktab || isUpper,
      meta: key.meta,
    },
    name,
  );
}
