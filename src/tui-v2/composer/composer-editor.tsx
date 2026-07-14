/** @jsxImportSource @opentui/react */
/**
 * Real composer renderable (V2-040..045, V2-047).
 *
 * Wraps OpenTUI's `TextareaRenderable`, which already implements move/select/
 * word/delete/undo editing (INPUT-004/005) natively. This component adds the
 * behavior the native default gets backwards or doesn't have at all: Enter
 * submits (via a small keyBindings override + native `onSubmit`), Ctrl+J is
 * reserved for jobs instead of newline, Up/Down recall prompt history only at
 * a line boundary, large pastes collapse to a placeholder, and slash/mention
 * tokens drive a completion menu.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  decodePasteBytes,
  stripAnsiSequences,
  type KeyEvent,
  type TextareaRenderable,
} from "@opentui/core";
import { usePaste } from "@opentui/react";
import { shouldStoreInPromptHistory } from "../../tui/input-history.js";
import { safeCwd } from "../../os/cwd.js";
import type { AppServices } from "../bootstrap/composition-root.js";
import type { Theme } from "../rendering/theme.js";
import { chordFromKeyEvent } from "../actions/chord-from-key.js";
import {
  shouldNavigateHistoryDown,
  shouldNavigateHistoryUp,
} from "./history-nav.js";
import { PromptHistory } from "./prompt-history.js";
import { isLargePaste, PasteRegistry } from "./paste-placeholder.js";
import { resolveCompletionMenu, type CompletionMenu } from "./completion.js";
import { buildComposerTextareaOverrides } from "./textarea-keybindings.js";
import { resolveNewlineHint } from "./newline-hint.js";

export interface ComposerEditorProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly width: number;
  readonly height: number;
  readonly focused: boolean;
}

// Structurally matches @opentui/core's TextareaAction KeyBinding; cast avoids
// importing that name from the ambiguous renderables barrel export.
const textareaKeyBindings = buildComposerTextareaOverrides() as never;

function menuLabel(item: { name?: string; label?: string; isDir?: boolean }): string {
  if (item.label !== undefined) return item.isDir ? `${item.label}` : item.label;
  return `/${item.name}`;
}

export function ComposerEditor(props: ComposerEditorProps): ReactNode {
  const { services, theme } = props;
  const editorRef = useRef<TextareaRenderable>(null);
  const promptHistory = useRef(new PromptHistory());
  const pasteRegistry = useRef(new PasteRegistry());
  const [menu, setMenu] = useState<CompletionMenu>({ kind: "none" });
  const [selected, setSelected] = useState(0);
  const newlineHint = useMemo(
    () => resolveNewlineHint(services.capabilities),
    [services.capabilities],
  );

  useEffect(() => {
    if (props.focused) editorRef.current?.focus();
    else editorRef.current?.blur();
  }, [props.focused]);

  usePaste((event) => {
    if (!props.focused) return;
    const text = stripAnsiSequences(decodePasteBytes(event.bytes));
    if (!isLargePaste(text)) return;
    event.preventDefault();
    const entry = pasteRegistry.current.register(text);
    editorRef.current?.insertText(entry.token);
  });

  function refreshMenu(): void {
    const editor = editorRef.current;
    if (!editor) return;
    setMenu(
      resolveCompletionMenu(
        services.commands,
        editor.plainText,
        editor.cursorOffset,
        safeCwd(),
      ),
    );
    setSelected(0);
  }

  function acceptSuggestion(): void {
    const editor = editorRef.current;
    if (!editor || menu.kind === "none") return;
    const cursor = editor.cursorOffset;
    const value = editor.plainText;
    let replacement: string;
    let start: number;
    if (menu.kind === "slash") {
      const item = menu.items[selected];
      if (!item) return;
      replacement = `/${item.name} `;
      start = menu.start;
    } else {
      const item = menu.items[selected];
      if (!item) return;
      replacement = `@${item.value}${item.isDir ? "" : " "}`;
      start = menu.start;
    }
    const end = menu.kind === "slash" ? menu.end : cursor;
    const next = value.slice(0, start) + replacement + value.slice(end);
    editor.replaceText(next);
    editor.setCursor(0, start + replacement.length);
    setMenu({ kind: "none" });
  }

  function submit(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const expanded = pasteRegistry.current.expand(editor.plainText).trim();
    editor.clear();
    pasteRegistry.current.clear();
    promptHistory.current.reset();
    setMenu({ kind: "none" });
    if (!expanded) return;
    if (shouldStoreInPromptHistory(expanded)) promptHistory.current.push(expanded);
    void dispatchOrRunTurn(expanded);
  }

  async function dispatchOrRunTurn(prompt: string): Promise<void> {
    const invocation = services.commands.parse(prompt);
    if (invocation && (await services.commands.dispatch(invocation))) return;
    if (services.session.getState().running) {
      services.session.enqueue(prompt);
    } else {
      await services.session.submit(prompt);
    }
  }

  function onKeyDown(key: KeyEvent): void {
    const editor = editorRef.current;
    if (!editor) return;
    const chord = chordFromKeyEvent(key);

    if (menu.kind !== "none") {
      if (chord === "up") {
        setSelected((i) => (i - 1 + menu.items.length) % menu.items.length);
        key.preventDefault();
        return;
      }
      if (chord === "down") {
        setSelected((i) => (i + 1) % menu.items.length);
        key.preventDefault();
        return;
      }
      if (chord === "tab" || chord === "enter") {
        acceptSuggestion();
        key.preventDefault();
        return;
      }
      if (chord === "escape") {
        setMenu({ kind: "none" });
        key.preventDefault();
        return;
      }
    }

    if (chord === "ctrl+j") {
      // Jobs owns Ctrl+J (CMD-003); swallow it so the native "linefeed"
      // binding never inserts a newline. The jobs overlay itself is Phase 7.
      key.preventDefault();
      return;
    }
    if (chord === "ctrl+u") {
      key.preventDefault();
      editor.clear();
      promptHistory.current.reset();
      return;
    }
    if (chord === "up" || chord === "down") {
      const info = { line: editor.logicalCursor.row, lineCount: editor.lineCount };
      const atBoundary =
        chord === "up" ? shouldNavigateHistoryUp(info) : shouldNavigateHistoryDown(info);
      if (atBoundary) {
        const recalled =
          chord === "up"
            ? promptHistory.current.prev(editor.plainText)
            : promptHistory.current.next();
        if (recalled !== undefined) {
          key.preventDefault();
          editor.setText(recalled);
          editor.gotoBufferEnd();
        }
      }
    }
  }

  return (
    <box style={{ flexDirection: "column", width: props.width, height: props.height }}>
      {menu.kind !== "none" ? (
        <box style={{ flexDirection: "column", backgroundColor: theme.statusBackground }}>
          {menu.items.slice(0, 6).map((item, i) => (
            <text
              key={menuLabel(item)}
              style={{ fg: i === selected ? theme.accent : theme.muted }}
            >
              {i === selected ? "> " : "  "}
              {menuLabel(item)}
            </text>
          ))}
        </box>
      ) : null}
      <textarea
        ref={editorRef}
        focused={props.focused}
        placeholder={`Type a message… (${newlineHint.label})`}
        placeholderColor={theme.muted}
        textColor={theme.foreground}
        backgroundColor={theme.background}
        keyBindings={textareaKeyBindings}
        onSubmit={submit}
        onContentChange={refreshMenu}
        onCursorChange={refreshMenu}
        onKeyDown={onKeyDown}
        style={{ flexGrow: 1, width: "100%" }}
      />
    </box>
  );
}
