/**
 * Composer overrides for the native Textarea key-binding table (INPUT-002,
 * V2-040/041).
 *
 * OpenTUI's `TextareaRenderable` already implements move/select/word/delete/
 * undo semantics (INPUT-004/005) — this module only overrides the small set
 * of chords where the library default is wrong for a submit-on-Enter
 * composer, plus explicit word vs line kill chords:
 *
 *   Option/Alt + Backspace/Delete  → delete one word
 *   Cmd (Mac) / Ctrl (Win) + Backspace/Delete → delete whole line
 *
 * Terminals report modifiers inconsistently: Option is usually `meta`, Cmd
 * is usually `super` (and sometimes arrives as Ctrl+U for Backspace).
 */

export type TextareaActionName =
  | "submit"
  | "newline"
  | "delete-to-line-start"
  | "delete-to-line-end"
  | "delete-line"
  | "delete-word-backward"
  | "delete-word-forward"
  | "select-all"
  | "select-word-backward"
  | "select-word-forward"
  | "select-line-home"
  | "select-line-end";

export interface TextareaKeyBindingLike {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly super?: boolean;
  readonly action: TextareaActionName;
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

  // ── Word kill: Option/Alt (+Backspace/Delete)
  // On macOS terminals, Option almost always arrives as `meta`.
  overrides.push({
    name: "backspace",
    meta: true,
    action: "delete-word-backward",
  });
  overrides.push({
    name: "delete",
    meta: true,
    action: "delete-word-forward",
  });

  // ── Full line kill: Cmd (super) and Ctrl (Windows / some terminals)
  // OpenTUI default maps ctrl+backspace → word; override to whole line.
  overrides.push({ name: "backspace", super: true, action: "delete-line" });
  overrides.push({ name: "delete", super: true, action: "delete-line" });
  overrides.push({ name: "backspace", ctrl: true, action: "delete-line" });
  overrides.push({ name: "delete", ctrl: true, action: "delete-line" });

  // readline Ctrl+U and many terminals' Cmd+Backspace → Ctrl+U encoding.
  overrides.push({ name: "u", ctrl: true, action: "delete-line" });
  // Ctrl+K keeps "kill to end of line" (readline) for power users.
  overrides.push({ name: "k", ctrl: true, action: "delete-to-line-end" });

  // ── Selection
  // OpenTUI's defaults bind shift+arrow and shift+home/end, but never bind
  // `select-all` or the word/line selection actions, so those were unreachable.
  // Cmd+A is the platform-native select-all; Ctrl+Alt+A covers terminals that
  // do not deliver super, without shadowing readline Ctrl+A (line-home).
  overrides.push({ name: "a", super: true, action: "select-all" });
  overrides.push({ name: "a", ctrl: true, meta: true, action: "select-all" });
  // Option/Alt + Shift + arrow → extend by word (macOS/most terminals).
  overrides.push({
    name: "left",
    meta: true,
    shift: true,
    action: "select-word-backward",
  });
  overrides.push({
    name: "right",
    meta: true,
    shift: true,
    action: "select-word-forward",
  });
  // Cmd + Shift + arrow → extend to the visual line edge.
  overrides.push({
    name: "left",
    super: true,
    shift: true,
    action: "select-line-home",
  });
  overrides.push({
    name: "right",
    super: true,
    shift: true,
    action: "select-line-end",
  });

  return overrides;
}

/**
 * Editor-modal bindings: Enter inserts a newline (Ctrl+S saves instead), while
 * the word/line kill and selection chords stay identical to the composer.
 */
export function buildTextEditorTextareaOverrides(): TextareaKeyBindingLike[] {
  const overrides = buildComposerTextareaOverrides().filter(
    (binding) =>
      !(ENTER_NAMES as readonly string[]).includes(binding.name) ||
      binding.action !== "submit",
  );
  for (const name of ENTER_NAMES) {
    overrides.push({ name, action: "newline" });
  }
  return overrides;
}
