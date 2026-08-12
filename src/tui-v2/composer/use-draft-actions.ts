/**
 * Draft-level composer actions and their registration on
 * {@link composerActionPort}, so status chrome and keystrokes share one path.
 */

import { useEffect, type RefObject } from "react";
import type { TextareaRenderable } from "@opentui/core";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { cutDraft, cutDraftMessage, primeCommandMenu } from "../../ui-core/composer/draft-actions.js";

export interface DraftActionsInput {
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly services: AppServices;
  /** Expands paste placeholders into the real text. */
  readonly expandPastes: (text: string) => string;
  /** Drop paste + prompt-history state tied to the current draft. */
  readonly resetRegistries: () => void;
  /** Collapse the completion menu and any accepted-slash marker. */
  readonly resetMenuState: () => void;
  readonly setContentRows: (rows: number) => void;
  readonly clearPasteChips: () => void;
  readonly focusComposer: () => boolean;
  readonly refreshMenu: () => void;
  readonly syncContentRows: () => void;
  readonly notify: (message: string, durationMs: number) => void;
}

export interface DraftActions {
  /** Wipe the draft and everything derived from it. */
  readonly clear: (editor: TextareaRenderable) => void;
  /** Ctrl+X — copy the draft to the clipboard, then clear it. */
  readonly cut: () => Promise<void>;
  /** Show every slash command, as typing "/" in the composer does. */
  readonly showCommands: () => void;
}

export function useDraftActions(input: DraftActionsInput): DraftActions {
  const clear = (editor: TextareaRenderable): void => {
    editor.clear();
    input.resetRegistries();
    input.resetMenuState();
    input.setContentRows(1);
    input.clearPasteChips();
    composerActionPort.setHasDraft(false);
  };

  const cut = async (): Promise<void> => {
    const editor = input.editorRef.current;
    if (!editor) return;
    const outcome = await cutDraft({
      editor,
      clipboard: input.services.ports.clipboard,
      expand: input.expandPastes,
      clearDraft: () => clear(editor),
      focus: input.focusComposer,
    });
    input.notify(cutDraftMessage(outcome), outcome === "empty" ? 1400 : 1600);
  };

  const showCommands = (): void => {
    const editor = input.editorRef.current;
    if (!editor || !input.focusComposer()) return;
    primeCommandMenu(editor);
    input.refreshMenu();
    input.syncContentRows();
  };

  // Re-registered every render so the handlers close over current state.
  useEffect(() => {
    const unregisterClear = composerActionPort.registerClear(() => {
      const editor = input.editorRef.current;
      if (!editor) return;
      clear(editor);
      input.focusComposer();
    });
    const unregisterCut = composerActionPort.registerCut(() => {
      void cut();
    });
    const unregisterCommands =
      composerActionPort.registerOpenCommands(showCommands);
    return () => {
      unregisterClear();
      unregisterCut();
      unregisterCommands();
    };
  });

  return { clear, cut, showCommands };
}
