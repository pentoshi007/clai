/**
 * Composer overrides for the native Textarea key-binding table (INPUT-002,
 * V2-040/041).
 *
 * OpenTUI's `TextareaRenderable` already implements move/select/word/delete/
 * undo semantics (INPUT-004/005) — this module only overrides the small set
 * of chords where the library default is backwards for a submit-on-Enter
 * composer (its default binds bare Enter to "newline" and Alt+Enter to
 * "submit"). Everything else passes through untouched. The shape here
 * mirrors `@opentui/core`'s `KeyBinding<TextareaAction>` structurally without
 * importing it, keeping this module renderer-independent; the renderer glue
 * casts it at the one place it is consumed.
 */

export interface TextareaKeyBindingLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly action: "submit" | "newline";
}

const ENTER_NAMES = ["return", "kpenter"] as const;

export function buildComposerTextareaOverrides(): TextareaKeyBindingLike[] {
  const overrides: TextareaKeyBindingLike[] = [];
  for (const name of ENTER_NAMES) {
    // Bare Enter → submit. Newline chords cover every OS/terminal that can
    // report a modifier on Return (Shift, Alt/Option/meta, Ctrl).
    overrides.push({ name, action: "submit" });
    overrides.push({ name, shift: true, action: "newline" });
    overrides.push({ name, meta: true, action: "newline" });
    overrides.push({ name, ctrl: true, action: "newline" });
  }
  return overrides;
}
