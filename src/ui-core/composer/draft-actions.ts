/**
 * Draft-level composer actions that need more than a keystroke: cut (copy then
 * clear) and "show every slash command". Kept out of the editor component so
 * the clipboard call site stays explicit and reviewable.
 */

import type { ClipboardPort } from "../../app/ports/clipboard-port.js";

export interface DraftEditor {
  readonly plainText: string;
  setText(value: string): void;
  gotoBufferEnd(): void;
}

export interface CutDraftInput {
  readonly editor: DraftEditor;
  readonly clipboard: ClipboardPort;
  /** Expands paste placeholders so the clipboard gets the real text. */
  readonly expand: (text: string) => string;
  readonly clearDraft: () => void;
  readonly focus: () => void;
}

export type CutDraftOutcome = "empty" | "cut" | "cleared-copy-failed";

/**
 * Ctrl+X. The draft is cleared whether or not the copy succeeded, so the
 * key never silently does nothing; the caller reports which happened.
 */
export async function cutDraft(input: CutDraftInput): Promise<CutDraftOutcome> {
  const draft = input.expand(input.editor.plainText);
  if (!draft.trim()) return "empty";
  let copied = true;
  try {
    await input.clipboard.writeText(draft);
  } catch {
    copied = false;
  }
  input.clearDraft();
  input.focus();
  return copied ? "cut" : "cleared-copy-failed";
}

export function cutDraftMessage(outcome: CutDraftOutcome): string {
  switch (outcome) {
    case "empty":
      return "Nothing to cut · draft is empty";
    case "cut":
      return "Draft cut to clipboard · ^X";
    default:
      return "Draft cleared — clipboard unavailable";
  }
}

/**
 * Put the composer into the state typing "/" produces, so the click target in
 * the status row and the keystroke show the identical command list.
 */
export function primeCommandMenu(editor: DraftEditor): void {
  if (!editor.plainText.startsWith("/")) {
    editor.setText(`/${editor.plainText}`);
  }
  editor.gotoBufferEnd();
}
