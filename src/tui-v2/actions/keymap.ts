/**
 * Default keymap and conflict validation (V2-033).
 *
 * A chord is a normalized, case-insensitive string ("ctrl+c", "shift+enter",
 * "up"). Bindings are data: help/status text and tests read them so no
 * component hardcodes terminal bytes. `validateKeymap` guarantees a context
 * never binds one chord to two different actions, which is asserted in tests so
 * new bindings cannot silently shadow existing ones.
 */

import type { ActionContext, ActionId } from "./action-id.js";

export interface KeyBinding {
  readonly chord: string;
  readonly action: ActionId;
  readonly context: ActionContext;
}

export interface KeymapConflict {
  readonly context: ActionContext;
  readonly chord: string;
  readonly actions: readonly ActionId[];
}

const MODIFIER_ORDER = ["ctrl", "alt", "shift", "meta"] as const;

/** Normalize a chord to `ctrl+alt+shift+meta+key` with a lowercase key. */
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

function binding(
  chord: string,
  action: ActionId,
  context: ActionContext,
): KeyBinding {
  return { chord: normalizeChord(chord), action, context };
}

export const defaultKeymap: readonly KeyBinding[] = [
  // global
  // Ctrl+C: abort-then-quit (double press). Esc: abort/dismiss only — never quit.
  binding("ctrl+c", "app.interrupt", "global"),
  binding("escape", "app.cancel", "global"),
  binding("ctrl+d", "app.quit", "global"),
  binding("ctrl+g", "app.help", "global"),
  binding("ctrl+h", "app.toggle-plan", "global"),
  binding("ctrl+p", "plan.toggle-detail", "global"),
  binding("ctrl+j", "app.jobs", "global"),
  binding("ctrl+t", "transcript.toggle-thinking", "global"),
  binding("ctrl+o", "transcript.toggle-output", "global"),
  binding("tab", "focus.next-region", "global"),

  // composer
  binding("enter", "editor.submit", "composer"),
  binding("shift+enter", "editor.newline", "composer"),
  binding("alt+enter", "editor.newline", "composer"),
  binding("up", "editor.history-prev", "composer"),
  binding("down", "editor.history-next", "composer"),
  binding("ctrl+u", "editor.clear", "composer"),

  // transcript
  binding("up", "transcript.scroll-up", "transcript"),
  binding("down", "transcript.scroll-down", "transcript"),
  binding("pageup", "transcript.page-up", "transcript"),
  binding("pagedown", "transcript.page-down", "transcript"),
  binding("g", "transcript.top", "transcript"),
  binding("shift+g", "transcript.bottom", "transcript"),
  binding("ctrl+r", "transcript.search", "transcript"),
  binding("enter", "transcript.expand-toggle", "transcript"),
  // Terminals that reserve Ctrl+C for copy use Ctrl+Shift+C for selection copy.
  binding("ctrl+shift+c", "selection.copy", "transcript"),
  binding("escape", "selection.clear", "transcript"),
  binding("ctrl+a", "selection.select-all", "transcript"),
  binding("shift+left", "selection.extend-left", "transcript"),
  binding("shift+right", "selection.extend-right", "transcript"),
  binding("shift+up", "selection.extend-up", "transcript"),
  binding("shift+down", "selection.extend-down", "transcript"),
  binding("ctrl+shift+left", "selection.extend-word-left", "transcript"),
  binding("ctrl+shift+right", "selection.extend-word-right", "transcript"),
  binding("shift+home", "selection.extend-line-start", "transcript"),
  binding("shift+end", "selection.extend-line-end", "transcript"),

  // picker
  binding("up", "picker.up", "picker"),
  binding("down", "picker.down", "picker"),
  binding("enter", "picker.accept", "picker"),
  binding("escape", "picker.dismiss", "picker"),

  // modal
  binding("y", "modal.confirm", "modal"),
  binding("n", "modal.deny", "modal"),
  binding("escape", "modal.dismiss", "modal"),

  // plan
  binding("down", "plan.next-task", "plan"),
  binding("up", "plan.prev-task", "plan"),
  binding("enter", "plan.toggle-detail", "plan"),

  // transcript search
  binding("escape", "picker.dismiss", "transcript-search"),
  binding("enter", "picker.accept", "transcript-search"),

  // pager
  binding("up", "pager.line-up", "pager"),
  binding("k", "pager.line-up", "pager"),
  binding("down", "pager.line-down", "pager"),
  binding("j", "pager.line-down", "pager"),
  binding("pageup", "pager.page-up", "pager"),
  binding("pagedown", "pager.page-down", "pager"),
  binding("ctrl+u", "pager.half-page-up", "pager"),
  binding("ctrl+d", "pager.half-page-down", "pager"),
  binding("g", "pager.top", "pager"),
  binding("shift+g", "pager.bottom", "pager"),
  binding("ctrl+r", "pager.search", "pager"),
  binding("n", "pager.next-match", "pager"),
  binding("shift+n", "pager.prev-match", "pager"),
  // Many terminals drop Shift on Ctrl chords, so bind both forms. Bare `s`
  // is also available (pager traps input; no conflict with transcript search).
  binding("ctrl+shift+s", "pager.export-scrollback", "pager"),
  binding("ctrl+s", "pager.export-scrollback", "pager"),
  binding("s", "pager.export-scrollback", "pager"),
  binding("ctrl+shift+e", "pager.export-editor", "pager"),
  binding("ctrl+e", "pager.export-editor", "pager"),
  binding("e", "pager.export-editor", "pager"),
  binding("c", "pager.copy", "pager"),
  binding("q", "pager.close", "pager"),
  binding("escape", "pager.close", "pager"),

  // jobs
  binding("up", "jobs.up", "jobs"),
  binding("down", "jobs.down", "jobs"),
  binding("enter", "jobs.tail", "jobs"),
  binding("t", "jobs.tail", "jobs"),
  binding("k", "jobs.stop", "jobs"),
  binding("q", "jobs.close", "jobs"),
  binding("escape", "jobs.close", "jobs"),
];

export function validateKeymap(
  bindings: readonly KeyBinding[],
): KeymapConflict[] {
  const byKey = new Map<string, Set<ActionId>>();
  for (const b of bindings) {
    const key = `${b.context}::${b.chord}`;
    const set = byKey.get(key) ?? new Set<ActionId>();
    set.add(b.action);
    byKey.set(key, set);
  }
  const conflicts: KeymapConflict[] = [];
  for (const [key, actions] of byKey) {
    if (actions.size > 1) {
      const [context, chord] = key.split("::") as [ActionContext, string];
      conflicts.push({ context, chord, actions: [...actions] });
    }
  }
  return conflicts;
}
