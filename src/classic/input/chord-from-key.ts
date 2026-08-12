import { chordFrom } from "../../ui-core/actions/chord.js";
import type { KeyEvent } from "./key-event.js";

const ENTER_NAMES = new Set(["return", "kpenter", "enter"]);

export function chordFromKey(key: KeyEvent): string {
  const isLinefeed = key.name === "linefeed";
  const isBacktab = key.name === "backtab";
  const isUpper = key.name.length === 1 && key.name >= "A" && key.name <= "Z";
  const raw = key.name.toLowerCase();
  const name = isLinefeed
    ? "j"
    : isBacktab
      ? "tab"
      : raw === " "
        ? "space"
        : ENTER_NAMES.has(key.name)
          ? "enter"
          : raw;

  return chordFrom(
    {
      ctrl: key.ctrl || isLinefeed,
      alt: key.alt,
      shift: key.shift || isBacktab || isUpper,
      meta: key.meta,
      super: key.super,
    },
    name,
  );
}
