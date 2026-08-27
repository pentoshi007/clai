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
import { normalizeChord } from "./chord.js";

export { normalizeChord } from "./chord.js";

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

function binding(
  chord: string,
  action: ActionId,
  context: ActionContext,
): KeyBinding {
  return { chord: normalizeChord(chord), action, context };
}

export const defaultKeymap: readonly KeyBinding[] = [
  // global
  // Ctrl+C: abort-then-quit (double press). Esc: dismiss/arm, then cancel all.
  // Exit: double Ctrl+C or /exit. (Ctrl+D is chat jump-to-bottom, not quit.)
  binding("ctrl+c", "app.interrupt", "global"),
  binding("escape", "app.cancel", "global"),
  binding("ctrl+g", "app.help", "global"),
  binding("ctrl+h", "app.toggle-plan", "global"),
  binding("ctrl+p", "plan.toggle-detail", "global"),
  binding("ctrl+j", "app.jobs", "global"),
  binding("ctrl+t", "transcript.toggle-thinking", "global"),
  binding("ctrl+o", "transcript.toggle-output", "global"),
  // Shift+Tab cycles ask → agent → plan from any base region (bare Tab is
  // reserved for the composer completion menu / focus, so it stays free).
  binding("shift+tab", "app.cycle-mode", "global"),
  // Absolute bottom of chat from anywhere (including composer).
  // Ctrl+U is NOT global: macOS Cmd+Backspace often arrives as Ctrl+U, and
  // OpenTUI's textarea uses ctrl+u for delete-to-line-start. Jump-to-top is
  // bound on transcript/pager; from composer only when the draft is empty
  // (handled in App.tsx so typing never scrolls the chat).
  // No bare g/G — those conflict with typing.
  binding("ctrl+d", "transcript.bottom", "global"),
  binding("tab", "focus.next-region", "global"),
  binding("ctrl+y", "queue.select-prev", "global"),
  binding("ctrl+v", "queue.select-next", "global"),
  binding("ctrl+s", "queue.send-now", "global"),
  binding("ctrl+]", "queue.edit", "global"),
  binding("ctrl+_", "queue.remove", "global"),

  // composer
  binding("enter", "editor.submit", "composer"),
  binding("shift+enter", "editor.newline", "composer"),
  binding("alt+enter", "editor.newline", "composer"),
  binding("ctrl+enter", "editor.newline", "composer"),
  binding("ctrl+n", "editor.newline", "composer"),
  binding("up", "editor.history-prev", "composer"),
  binding("down", "editor.history-next", "composer"),
  binding("ctrl+x", "editor.cut-draft", "composer"),
  binding("ctrl+q", "editor.clear", "composer"),

  // transcript
  binding("up", "transcript.scroll-up", "transcript"),
  binding("down", "transcript.scroll-down", "transcript"),
  binding("pageup", "transcript.page-up", "transcript"),
  binding("pagedown", "transcript.page-down", "transcript"),
  binding("ctrl+u", "transcript.top", "transcript"),
  binding("ctrl+d", "transcript.bottom", "transcript"),
  binding("home", "transcript.top", "transcript"),
  binding("end", "transcript.bottom", "transcript"),
  binding("ctrl+r", "transcript.search", "transcript"),
  // Bare `c` copies the focused thinking card. Only reachable while the
  // transcript owns the keyboard, so it never swallows typing in the composer.
  binding("c", "transcript.copy-thinking", "transcript"),
  binding("enter", "transcript.expand-toggle", "transcript"),
  // Terminals that reserve Ctrl+C for copy use Ctrl+Shift+C for selection copy.
  binding("ctrl+shift+c", "selection.copy", "transcript"),
  binding("escape", "selection.clear", "transcript"),
  binding("ctrl+a", "selection.select-all", "transcript"),
  // Keyboard range extension is intentionally unbound: the transcript has no
  // caret or range highlight, so shift+arrow selections were invisible. Mouse
  // drag (native selection) and Ctrl+A + Ctrl+Shift+C cover copying.

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
  // Match chat: ^U/^D = absolute top/bottom (no g/G).
  binding("ctrl+u", "pager.top", "pager"),
  binding("ctrl+d", "pager.bottom", "pager"),
  binding("home", "pager.top", "pager"),
  binding("end", "pager.bottom", "pager"),
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
  // Follow/pause a live job feed. No-op on static bodies.
  binding("l", "pager.toggle-follow", "pager"),
  // Markdown view toggle (tool dumps, .md files, mixed bodies).
  binding("f", "pager.format", "pager"),
  binding("r", "pager.raw", "pager"),
  binding("q", "pager.close", "pager"),
  binding("escape", "pager.close", "pager"),

  // jobs
  binding("up", "jobs.up", "jobs"),
  binding("down", "jobs.down", "jobs"),
  binding("enter", "jobs.view-live", "jobs"),
  binding("v", "jobs.view-live", "jobs"),
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
