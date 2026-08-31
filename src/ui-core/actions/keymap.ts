
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
  binding("ctrl+c", "app.interrupt", "global"),
  binding("escape", "app.cancel", "global"),
  binding("ctrl+g", "app.help", "global"),
  binding("ctrl+h", "app.toggle-plan", "global"),
  binding("ctrl+p", "plan.toggle-detail", "global"),
  binding("ctrl+j", "app.jobs", "global"),
  binding("ctrl+t", "transcript.toggle-thinking", "global"),
  binding("ctrl+o", "transcript.toggle-output", "global"),
  binding("shift+tab", "app.cycle-mode", "global"),
  binding("ctrl+d", "transcript.bottom", "global"),
  binding("tab", "focus.next-region", "global"),
  binding("ctrl+y", "queue.select-prev", "global"),
  binding("ctrl+v", "queue.select-next", "global"),
  binding("ctrl+s", "queue.send-now", "global"),
  binding("ctrl+]", "queue.edit", "global"),
  binding("ctrl+_", "queue.remove", "global"),

  binding("enter", "editor.submit", "composer"),
  binding("shift+enter", "editor.newline", "composer"),
  binding("alt+enter", "editor.newline", "composer"),
  binding("ctrl+enter", "editor.newline", "composer"),
  binding("ctrl+n", "editor.newline", "composer"),
  binding("up", "editor.history-prev", "composer"),
  binding("down", "editor.history-next", "composer"),
  binding("ctrl+x", "editor.cut-draft", "composer"),
  binding("ctrl+q", "editor.clear", "composer"),

  binding("up", "transcript.scroll-up", "transcript"),
  binding("down", "transcript.scroll-down", "transcript"),
  binding("pageup", "transcript.page-up", "transcript"),
  binding("pagedown", "transcript.page-down", "transcript"),
  binding("ctrl+u", "transcript.top", "transcript"),
  binding("ctrl+d", "transcript.bottom", "transcript"),
  binding("home", "transcript.top", "transcript"),
  binding("end", "transcript.bottom", "transcript"),
  binding("ctrl+r", "transcript.search", "transcript"),
  binding("c", "transcript.copy-thinking", "transcript"),
  binding("enter", "transcript.expand-toggle", "transcript"),
  binding("ctrl+shift+c", "selection.copy", "transcript"),
  binding("escape", "selection.clear", "transcript"),
  binding("ctrl+a", "selection.select-all", "transcript"),

  binding("up", "picker.up", "picker"),
  binding("down", "picker.down", "picker"),
  binding("enter", "picker.accept", "picker"),
  binding("escape", "picker.dismiss", "picker"),

  binding("y", "modal.confirm", "modal"),
  binding("n", "modal.deny", "modal"),
  binding("escape", "modal.dismiss", "modal"),

  binding("down", "plan.next-task", "plan"),
  binding("up", "plan.prev-task", "plan"),
  binding("enter", "plan.toggle-detail", "plan"),

  binding("escape", "picker.dismiss", "transcript-search"),
  binding("enter", "picker.accept", "transcript-search"),

  binding("up", "pager.line-up", "pager"),
  binding("k", "pager.line-up", "pager"),
  binding("down", "pager.line-down", "pager"),
  binding("j", "pager.line-down", "pager"),
  binding("pageup", "pager.page-up", "pager"),
  binding("pagedown", "pager.page-down", "pager"),
  binding("ctrl+u", "pager.top", "pager"),
  binding("ctrl+d", "pager.bottom", "pager"),
  binding("home", "pager.top", "pager"),
  binding("end", "pager.bottom", "pager"),
  binding("ctrl+r", "pager.search", "pager"),
  binding("n", "pager.next-match", "pager"),
  binding("shift+n", "pager.prev-match", "pager"),
  binding("ctrl+shift+s", "pager.export-scrollback", "pager"),
  binding("ctrl+s", "pager.export-scrollback", "pager"),
  binding("s", "pager.export-scrollback", "pager"),
  binding("ctrl+shift+e", "pager.export-editor", "pager"),
  binding("ctrl+e", "pager.export-editor", "pager"),
  binding("e", "pager.export-editor", "pager"),
  binding("c", "pager.copy", "pager"),
  binding("l", "pager.toggle-follow", "pager"),
  binding("f", "pager.format", "pager"),
  binding("r", "pager.raw", "pager"),
  binding("q", "pager.close", "pager"),
  binding("escape", "pager.close", "pager"),

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
