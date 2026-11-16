export interface KeyEventLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
  readonly sequence?: string | undefined;
  readonly raw?: string | undefined;
  readonly eventType?: "press" | "repeat" | "release" | undefined;
  readonly source?: "raw" | "kitty" | undefined;
  readonly repeated?: boolean | undefined;
  readonly baseCode?: number | undefined;
}

const LATIN_SHORTCUT_KEY = /^[\x21-\x7e]$/;

export function layoutIndependentKeyName(
  name: string,
  baseCode: number | undefined,
  modified: boolean,
): string {
  if (!modified || baseCode === undefined || LATIN_SHORTCUT_KEY.test(name)) return name;
  if ([...name].length !== 1) return name;
  if (!Number.isInteger(baseCode) || baseCode < 0x21 || baseCode > 0x7e) return name;
  return String.fromCharCode(baseCode).toLowerCase();
}

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta", "super"] as const;

export type Modifier = (typeof MODIFIER_ORDER)[number];

export function normalizeChord(chord: string): string {
  const parts = chord
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const mods = new Set(parts.filter((p) => (MODIFIER_ORDER as readonly string[]).includes(p)));
  const keys = parts.filter((p) => !(MODIFIER_ORDER as readonly string[]).includes(p));
  const key = keys[keys.length - 1] ?? "";
  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].filter(Boolean).join("+");
}

export function chordFrom(modifiers: {
  readonly ctrl?: boolean | undefined;
  readonly alt?: boolean | undefined;
  readonly shift?: boolean | undefined;
  readonly meta?: boolean | undefined;
  readonly super?: boolean | undefined;
}, key: string): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push("ctrl");
  if (modifiers.alt) parts.push("alt");
  if (modifiers.shift) parts.push("shift");
  if (modifiers.meta) parts.push("meta");
  if (modifiers.super) parts.push("super");
  parts.push(key);
  return normalizeChord(parts.join("+"));
}
