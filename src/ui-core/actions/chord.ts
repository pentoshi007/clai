export interface KeyEventLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly super?: boolean;
}

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

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
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
}, key: string): string {
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push("ctrl");
  if (modifiers.alt) parts.push("alt");
  if (modifiers.shift) parts.push("shift");
  if (modifiers.meta) parts.push("meta");
  parts.push(key);
  return normalizeChord(parts.join("+"));
}
