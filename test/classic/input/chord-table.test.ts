import { describe, expect, it } from "vitest";
import { ActionRouter } from "../../../src/ui-core/actions/action-router.js";
import { defaultKeymap } from "../../../src/ui-core/actions/keymap.js";
import { chordFromKey } from "../../../src/classic/input/chord-from-key.js";
import type { KeyEvent } from "../../../src/classic/input/key-event.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";

const NAMED_SEQUENCES: Readonly<Record<string, string>> = {
  enter: "\r",
  tab: "\t",
  escape: "\x1b",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  insert: "\x1b[2~",
  delete: "\x1b[3~",
};

const CSI_U_CODES: Readonly<Record<string, number>> = {
  enter: 13,
  tab: 9,
  escape: 27,
  space: 32,
  backspace: 127,
};

function modifierMask(mods: ReadonlySet<string>): number {
  let mask = 1;
  if (mods.has("shift")) mask += 1;
  if (mods.has("alt")) mask += 2;
  if (mods.has("ctrl")) mask += 4;
  if (mods.has("meta")) mask += 8;
  return mask;
}

function csiU(key: string, mods: ReadonlySet<string>): string {
  const code = CSI_U_CODES[key] ?? key.codePointAt(0);
  return `\x1b[${code};${modifierMask(mods)}u`;
}

export function bytesForChord(chord: string): string {
  const parts = chord.split("+");
  const key = parts[parts.length - 1] as string;
  const mods = new Set(parts.slice(0, -1));
  const isLetter = key.length === 1 && key >= "a" && key <= "z";

  if (mods.size === 0) {
    if (NAMED_SEQUENCES[key]) return NAMED_SEQUENCES[key] as string;
    if (/^f([1-9]|1[0-2])$/.test(key)) return csiU(key, mods);
    return key;
  }
  if (mods.size === 1 && mods.has("shift")) {
    if (key === "tab") return "\x1b[Z";
    if (isLetter) return key.toUpperCase();
    return csiU(key, mods);
  }
  if (mods.size === 1 && mods.has("ctrl") && isLetter) {
    return String.fromCharCode((key.codePointAt(0) as number) - 0x60);
  }
  if (mods.size === 1 && mods.has("alt")) {
    if (key === "enter") return "\x1b\r";
    if (key === "tab") return "\x1b\t";
    if (NAMED_SEQUENCES[key]?.startsWith("\x1b[")) return `\x1b${NAMED_SEQUENCES[key]}`;
    return `\x1b${key}`;
  }
  const named = NAMED_SEQUENCES[key];
  if (named?.startsWith("\x1b[")) {
    const rest = named.slice(2);
    const mask = modifierMask(mods);
    return rest.endsWith("~")
      ? `\x1b[${rest.slice(0, -1)};${mask}~`
      : `\x1b[1;${mask}${rest}`;
  }
  return csiU(key, mods);
}

function decodeOne(bytes: string): KeyEvent {
  const decoder = new RawDecoder();
  const events = [...decoder.push(bytes), ...decoder.flush()];
  const keys = events.flatMap((event) => (event.type === "key" ? [event.key] : []));
  expect(keys, `expected exactly one key event for ${JSON.stringify(bytes)}`).toHaveLength(1);
  return keys[0] as KeyEvent;
}

const uniqueChords = [...new Set(defaultKeymap.map((binding) => binding.chord))].sort();

describe("every defaultKeymap chord has a decoder path", () => {
  it("covers every binding in the keymap", () => {
    expect(uniqueChords.length).toBeGreaterThan(30);
  });

  for (const chord of uniqueChords) {
    it(`decodes bytes for ${chord}`, () => {
      expect(chordFromKey(decodeOne(bytesForChord(chord)))).toBe(chord);
    });
  }
});

describe("every (chord, context) binding resolves to its action", () => {
  const router = new ActionRouter();
  for (const binding of defaultKeymap) {
    it(`${binding.context}:${binding.chord} -> ${binding.action}`, () => {
      const chord = chordFromKey(decodeOne(bytesForChord(binding.chord)));
      expect(router.resolve(chord, binding.context)).toBe(binding.action);
    });
  }
});

describe("chordFromKey normalisation", () => {
  const key = (over: Partial<KeyEvent>): KeyEvent => ({
    name: "a",
    ctrl: false,
    alt: false,
    shift: false,
    meta: false,
    text: "",
    ...over,
  });

  it("orders modifiers ctrl+alt+shift+meta", () => {
    expect(
      chordFromKey(key({ name: "a", ctrl: true, alt: true, shift: true, meta: true })),
    ).toBe("ctrl+alt+shift+meta+a");
  });

  it("maps return and kpenter to enter", () => {
    expect(chordFromKey(key({ name: "return" }))).toBe("enter");
    expect(chordFromKey(key({ name: "kpenter" }))).toBe("enter");
  });

  it("maps linefeed to ctrl+j and backtab to shift+tab", () => {
    expect(chordFromKey(key({ name: "linefeed" }))).toBe("ctrl+j");
    expect(chordFromKey(key({ name: "backtab" }))).toBe("shift+tab");
  });

  it("treats an uppercase name as shift", () => {
    expect(chordFromKey(key({ name: "A" }))).toBe("shift+a");
  });

  it("lowercases the key name", () => {
    expect(chordFromKey(key({ name: "PageUp" }))).toBe("pageup");
  });
});
