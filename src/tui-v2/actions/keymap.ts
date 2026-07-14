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
  binding("ctrl+c", "app.cancel", "global"),
  binding("ctrl+d", "app.quit", "global"),
  binding("ctrl+g", "app.help", "global"),
  binding("ctrl+h", "app.toggle-plan", "global"),
  binding("ctrl+p", "plan.toggle-detail", "global"),
  binding("ctrl+j", "app.jobs", "global"),
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
  binding("ctrl+f", "transcript.search", "transcript"),
  binding("enter", "transcript.expand-toggle", "transcript"),

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
