/**
 * Semantic action identifiers and input contexts (V2-033).
 *
 * Actions are semantic, never byte-sequence promises: a component or test asks
 * for `editor.newline`, and the keymap plus terminal adapter decide which chord
 * currently delivers it. Contexts model where keyboard input is routed so the
 * same chord can mean different things in the composer, a picker, or a modal.
 */

export const ACTION_CONTEXTS = [
  "global",
  "transcript",
  "composer",
  "picker",
  "modal",
  "secret",
  "plan",
  "transcript-search",
  "pager",
  "jobs",
] as const;

export type ActionContext = (typeof ACTION_CONTEXTS)[number];

export const ACTION_IDS = [
  // global
  "app.quit",
  /** Esc: abort a running turn / dismiss — never exits the process. */
  "app.cancel",
  /**
   * Ctrl+C: first press aborts a running turn (or arms quit); second press
   * within a short window exits the process.
   */
  "app.interrupt",
  "app.help",
  "app.toggle-plan",
  "app.jobs",
  "focus.next-region",
  "focus.composer",
  "focus.transcript",
  // composer / editor
  "editor.submit",
  "editor.newline",
  "editor.history-prev",
  "editor.history-next",
  "editor.clear",
  // transcript / scrolling
  "transcript.scroll-up",
  "transcript.scroll-down",
  "transcript.page-up",
  "transcript.page-down",
  "transcript.top",
  "transcript.bottom",
  "transcript.search",
  "transcript.expand-toggle",
  "transcript.toggle-thinking",
  "transcript.toggle-output",
  // pane selection
  "selection.copy",
  "selection.clear",
  "selection.select-all",
  "selection.extend-left",
  "selection.extend-right",
  "selection.extend-up",
  "selection.extend-down",
  "selection.extend-word-left",
  "selection.extend-word-right",
  "selection.extend-line-start",
  "selection.extend-line-end",
  // picker
  "picker.up",
  "picker.down",
  "picker.accept",
  "picker.dismiss",
  "picker.filter",
  // modal
  "modal.confirm",
  "modal.deny",
  "modal.dismiss",
  // plan
  "plan.next-task",
  "plan.prev-task",
  "plan.toggle-detail",
  // pager
  "pager.line-up",
  "pager.line-down",
  "pager.page-up",
  "pager.page-down",
  "pager.half-page-up",
  "pager.half-page-down",
  "pager.top",
  "pager.bottom",
  "pager.search",
  "pager.next-match",
  "pager.prev-match",
  "pager.export-scrollback",
  "pager.export-editor",
  "pager.copy",
  "pager.close",
  // jobs
  "jobs.up",
  "jobs.down",
  "jobs.tail",
  "jobs.stop",
  "jobs.close",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export function isActionContext(value: string): value is ActionContext {
  return (ACTION_CONTEXTS as readonly string[]).includes(value);
}

export function isActionId(value: string): value is ActionId {
  return (ACTION_IDS as readonly string[]).includes(value);
}
