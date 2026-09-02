
import { useEffect, type RefObject } from "react";
import type { TextareaRenderable } from "@opentui/core";
import type { AppServices } from "../../ui-core/bootstrap/composition-root.js";
import { composerActionPort } from "../../ui-core/composer/composer-action-port.js";
import { cutDraft, cutDraftMessage, primeCommandMenu } from "../../ui-core/composer/draft-actions.js";
import { tokenInsertion } from "../../ui-core/composer/insert-token.js";

export interface DraftActionsInput {
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly services: AppServices;
  readonly expandPastes: (text: string) => string;
  readonly resetRegistries: () => void;
  readonly resetMenuState: () => void;
  readonly setContentRows: (rows: number) => void;
  readonly clearPasteChips: () => void;
  readonly focusComposer: () => boolean;
  readonly refreshMenu: () => void;
  readonly syncContentRows: () => void;
  readonly notify: (message: string, durationMs: number) => void;
}

export interface DraftActions {
  readonly clear: (editor: TextareaRenderable) => void;
  readonly cut: () => Promise<void>;
  readonly showCommands: () => void;
  readonly insert: (text: string) => void;
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

  const insert = (text: string): void => {
    const editor = input.editorRef.current;
    if (!editor) return;
    input.focusComposer();
    editor.insertText(
      tokenInsertion(editor.plainText.slice(0, editor.cursorOffset), text),
    );
    input.refreshMenu();
    input.syncContentRows();
  };

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
    const unregisterInsert = composerActionPort.registerInsert(insert);
    return () => {
      unregisterClear();
      unregisterCut();
      unregisterCommands();
      unregisterInsert();
    };
  });

  return { clear, cut, showCommands, insert };
}
