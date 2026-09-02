
import type { ClipboardPort } from "../../app/ports/clipboard-port.js";

export interface DraftEditor {
  readonly plainText: string;
  setText(value: string): void;
  gotoBufferEnd(): void;
}

export interface CutDraftInput {
  readonly editor: DraftEditor;
  readonly clipboard: ClipboardPort;
  readonly expand: (text: string) => string;
  readonly clearDraft: () => void;
  readonly focus: () => void;
}

export type CutDraftOutcome = "empty" | "cut" | "cleared-copy-failed";

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

export function primeCommandMenu(editor: DraftEditor): void {
  if (!editor.plainText.startsWith("/")) {
    editor.setText(`/${editor.plainText}`);
  }
  editor.gotoBufferEnd();
}
