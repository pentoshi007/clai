/**
 * Human-readable keyboard shortcut reference for /shortcuts.
 * Emits markdown so the pager can render headings, tables, and code chips.
 * Built from defaultKeymap so the list cannot drift from real bindings.
 */

import type { ActionContext, ActionId } from "./action-id.js";
import { defaultKeymap, type KeyBinding } from "./keymap.js";

const CONTEXT_ORDER: readonly ActionContext[] = [
  "global",
  "composer",
  "transcript",
  "plan",
  "pager",
  "jobs",
  "modal",
  "picker",
  "transcript-search",
];

const CONTEXT_TITLES: Record<ActionContext, string> = {
  global: "Global",
  composer: "Composer",
  transcript: "Transcript",
  plan: "Plan / tasks",
  pager: "Pager",
  jobs: "Jobs",
  modal: "Confirm modal",
  picker: "Picker",
  secret: "Secret prompt",
  "transcript-search": "Transcript search",
};

const CONTEXT_BLURBS: Partial<Record<ActionContext, string>> = {
  global: "Work from any focus (unless a modal traps keys).",
  composer: "While typing in the input box.",
  transcript: "When the chat pane has focus.",
  plan: "When the tasks pane is focused.",
  pager: "Inside full-output / help / plan detail views.",
  jobs: "Background jobs panel.",
  modal: "Yes/no and confirm dialogs.",
  picker: "Model, provider, history, and other menus.",
};

const ACTION_LABELS: Partial<Record<ActionId, string>> = {
  "app.interrupt": "Abort turn / arm exit (double-press to quit)",
  "app.cancel": "Cancel / dismiss (never quits)",
  "app.quit": "Quit",
  "app.help": "Open command help",
  "app.toggle-plan": "Toggle plan / tasks pane",
  "app.jobs": "Open background jobs",
  "jobs.view-live": "View selected job output (follows while it runs)",
  "pager.toggle-follow": "Follow / pause live output",
  "app.cycle-mode": "Cycle mode (ask → agent → plan)",
  "focus.next-region": "Cycle focus (composer → chat → plan)",
  "focus.composer": "Focus composer",
  "focus.transcript": "Focus transcript",
  "editor.submit": "Submit prompt",
  "editor.newline": "Insert newline",
  "editor.history-prev": "Previous prompt in history",
  "editor.history-next": "Next prompt in history",
  "editor.clear": "Clear draft",
  "editor.cut-draft": "Cut draft (copy to clipboard, then clear)",
  "transcript.scroll-up": "Scroll chat up",
  "transcript.scroll-down": "Scroll chat down",
  "transcript.page-up": "Page chat up",
  "transcript.page-down": "Page chat down",
  "transcript.top": "Jump to top of chat",
  "transcript.bottom": "Jump to bottom of chat",
  "transcript.search": "Search transcript",
  "transcript.expand-toggle": "Expand / collapse focused card",
  "transcript.toggle-thinking": "Toggle thinking blocks",
  "transcript.toggle-output": "Toggle tool / compacted output",
  "selection.copy": "Copy selection",
  "selection.clear": "Clear selection",
  "selection.select-all": "Select all",
  "selection.extend-left": "Extend selection left",
  "selection.extend-right": "Extend selection right",
  "selection.extend-up": "Extend selection up",
  "selection.extend-down": "Extend selection down",
  "selection.extend-word-left": "Extend selection word left",
  "selection.extend-word-right": "Extend selection word right",
  "selection.extend-line-start": "Extend selection to line start",
  "selection.extend-line-end": "Extend selection to line end",
  "picker.up": "Move selection up",
  "picker.down": "Move selection down",
  "picker.accept": "Accept",
  "picker.dismiss": "Dismiss",
  "modal.confirm": "Confirm",
  "modal.deny": "Deny",
  "modal.dismiss": "Dismiss",
  "plan.next-task": "Next task",
  "plan.prev-task": "Previous task",
  "plan.toggle-detail": "Open full plan detail",
  "pager.line-up": "Line up",
  "pager.line-down": "Line down",
  "pager.page-up": "Page up",
  "pager.page-down": "Page down",
  "pager.top": "Jump to top",
  "pager.bottom": "Jump to bottom",
  "pager.search": "Search in pager",
  "pager.next-match": "Next search match",
  "pager.prev-match": "Previous search match",
  "pager.export-scrollback": "Export to scrollback",
  "pager.export-editor": "Open in editor",
  "pager.copy": "Copy pager body",
  "pager.format": "Formatted markdown view",
  "pager.raw": "Raw text view",
  "pager.close": "Close pager",
  "jobs.up": "Previous job",
  "jobs.down": "Next job",
  "jobs.tail": "Snapshot of job output",
  "jobs.stop": "Stop job",
  "jobs.close": "Close jobs panel",
};

/** Pretty-print a normalized chord for humans. */
export function humanizeChord(chord: string): string {
  return chord
    .split("+")
    .map((part) => {
      const p = part.toLowerCase();
      if (p === "ctrl") return "Ctrl";
      if (p === "alt") return "Alt/Option";
      if (p === "shift") return "Shift";
      if (p === "meta") return "Cmd/Meta";
      if (p === "pageup") return "PageUp";
      if (p === "pagedown") return "PageDown";
      if (p === "escape") return "Esc";
      if (p === "enter") return "Enter";
      if (p === "backspace") return "Backspace";
      if (p === "delete") return "Delete";
      if (p === "tab") return "Tab";
      if (p === "up") return "↑";
      if (p === "down") return "↓";
      if (p === "left") return "←";
      if (p === "right") return "→";
      if (p === "home") return "Home";
      if (p === "end") return "End";
      if (p.length === 1) return p.toUpperCase();
      return part;
    })
    .join("+");
}

function labelFor(action: ActionId): string {
  return ACTION_LABELS[action] ?? action;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

const COMPOSER_TEXTAREA_NOTES: readonly { chord: string; label: string }[] = [
  {
    chord: "Option/Alt+Backspace",
    label: "Delete previous word",
  },
  {
    chord: "Option/Alt+Delete",
    label: "Delete next word",
  },
  {
    chord: "Cmd (Mac) / Ctrl (Win)+Backspace or Delete",
    label: "Delete the whole line",
  },
  {
    chord: "Ctrl+U",
    label:
      "Delete the whole line (macOS Cmd+Backspace often arrives as Ctrl+U). Empty draft → jump chat to top",
  },
  {
    chord: "Ctrl+A / Ctrl+E",
    label: "Line start / line end (readline)",
  },
  {
    chord: "Ctrl+K",
    label: "Delete to end of line (readline)",
  },
  {
    chord: "Ctrl+W",
    label: "Delete word backward",
  },
  {
    chord: "Double Ctrl+C",
    label: "Quit clai (first press aborts a running turn)",
  },
  {
    chord: "/exit or /quit",
    label: "Quit",
  },
  {
    chord: "/shortcuts",
    label: "This reference",
  },
  {
    chord: "/help",
    label: "Slash command list",
  },
];

/**
 * Markdown document for the keyboard shortcuts pager.
 */
export function formatShortcutsReference(
  bindings: readonly KeyBinding[] = defaultKeymap,
): string {
  const byContext = new Map<ActionContext, KeyBinding[]>();
  for (const b of bindings) {
    const list = byContext.get(b.context) ?? [];
    list.push(b);
    byContext.set(b.context, list);
  }

  const out: string[] = [
    "# Keyboard shortcuts",
    "",
    "Chords are **terminal-dependent**. On macOS, **Cmd+Backspace** often arrives as **Ctrl+U** (line delete in the composer — not chat scroll while typing).",
    "",
    "Status chips under the input are clickable: `^T` · `^O` · `^U` · `^D` · `^X` · `^Q`.",
    "",
  ];

  for (const ctx of CONTEXT_ORDER) {
    const list = byContext.get(ctx);
    if (!list || list.length === 0) continue;

    out.push(`## ${CONTEXT_TITLES[ctx]}`);
    out.push("");
    const blurb = CONTEXT_BLURBS[ctx];
    if (blurb) {
      out.push(`*${blurb}*`);
      out.push("");
    }

    out.push("| Keys | Action |");
    out.push("| --- | --- |");

    const byAction = new Map<ActionId, string[]>();
    for (const b of list) {
      const chords = byAction.get(b.action) ?? [];
      chords.push(humanizeChord(b.chord));
      byAction.set(b.action, chords);
    }
    for (const [action, chords] of byAction) {
      const keys = chords.map((c) => `\`${c}\``).join(" · ");
      out.push(`| ${escapeCell(keys)} | ${escapeCell(labelFor(action))} |`);
    }
    out.push("");
  }

  out.push("## Composer editing");
  out.push("");
  out.push("*Textarea defaults and clai overrides (not all appear in the action keymap).*");
  out.push("");
  out.push("| Keys | Action |");
  out.push("| --- | --- |");
  for (const note of COMPOSER_TEXTAREA_NOTES) {
    out.push(
      `| \`${escapeCell(note.chord)}\` | ${escapeCell(note.label)} |`,
    );
  }
  out.push("");
  out.push("---");
  out.push("");
  out.push("Tip: run `/help` for slash commands · `q` or `Esc` closes this pager.");

  return out.join("\n");
}
