/** @jsxImportSource @opentui/react */
/**
 * Multiline text editor overlay (long structured input such as MCP server
 * JSON). Uses the native textarea so the caret, arrow navigation, selection,
 * word/line kills and mid-text edits behave exactly like the composer —
 * Enter inserts a newline here and Ctrl+S saves.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  TextAttributes,
  type KeyEvent,
  type TextareaRenderable,
} from "@opentui/core";
import type { AppServices } from "../../../ui-core/bootstrap/composition-root.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import type { TextEditorRequest } from "../../../ui-core/controllers/overlay-controller.js";
import { chordFromKeyEvent } from "../../input/chord-from-opentui-key.js";
import { buildTextEditorTextareaOverrides } from "../../composer/textarea-keybindings.js";

const keyBindings = buildTextEditorTextareaOverrides() as never;

export interface TextEditorModalProps {
  readonly services: AppServices;
  readonly theme: Theme;
  readonly request: TextEditorRequest;
  readonly width: number;
  readonly height: number;
}

export function TextEditorModal(props: TextEditorModalProps): ReactNode {
  const { services, theme, request } = props;
  const editorRef = useRef<TextareaRenderable>(null);
  const [caret, setCaret] = useState({ line: 1, column: 1, lines: 1 });
  const width = Math.max(24, Math.min(props.width - 4, 120));
  const rows = Math.max(4, Math.min(props.height - 8, 24));

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (request.initialValue) {
      editor.setText(request.initialValue);
      editor.gotoBufferEnd();
    }
    editor.focus();
  }, [request.initialValue]);

  function syncCaret(): void {
    const editor = editorRef.current;
    if (!editor) return;
    const text = editor.plainText;
    const offset = Math.max(0, Math.min(editor.cursorOffset, text.length));
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - (before.lastIndexOf("\n") + 1) + 1;
    setCaret((current) =>
      current.line === line &&
      current.column === column &&
      current.lines === text.split("\n").length
        ? current
        : { line, column, lines: text.split("\n").length },
    );
  }

  function submit(): void {
    services.overlay.answerTextEditor(editorRef.current?.plainText ?? "");
  }

  function onKeyDown(key: KeyEvent): void {
    const chord = chordFromKeyEvent(key);
    if (chord === "ctrl+s") {
      key.preventDefault();
      submit();
      return;
    }
    if (chord === "escape") {
      key.preventDefault();
      services.overlay.answerTextEditor(undefined);
      return;
    }
  }

  return (
    <box
      border
      borderStyle="rounded"
      title={` ${request.title} `}
      titleAlignment="left"
      titleColor={theme.modalBorder}
      style={{
        flexDirection: "column",
        width,
        borderColor: theme.modalBorder,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text style={{ fg: theme.foreground }} content={request.prompt} />
      <box
        border
        borderStyle="single"
        style={{
          flexDirection: "row",
          width: "100%",
          height: rows + 2,
          borderColor: theme.inputBorder,
          backgroundColor: theme.statusBackground,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <textarea
          ref={editorRef}
          focused
          selectable
          selectionBg={theme.selection}
          selectionFg={theme.white}
          placeholder={request.placeholder ?? ""}
          placeholderColor={theme.muted}
          textColor={theme.foreground}
          backgroundColor={theme.statusBackground}
          cursorColor={theme.inputBorder}
          keyBindings={keyBindings}
          wrapMode="word"
          onKeyDown={onKeyDown}
          onContentChange={syncCaret}
          onCursorChange={syncCaret}
          style={{
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            minHeight: 1,
            width: 0,
            height: "100%",
          }}
        />
      </box>
      <box style={{ flexDirection: "row", width: "100%" }}>
        <text style={{ fg: theme.cyan, attributes: TextAttributes.BOLD }} content="› " />
        <text
          style={{ fg: theme.cyan }}
          content={`^S ${request.submitLabel ?? "save"}  ·  enter newline  ·  arrows move  ·  esc cancel`}
        />
        <text
          style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
          content={`   ln ${String(caret.line)}/${String(caret.lines)} · col ${String(caret.column)}`}
        />
      </box>
    </box>
  );
}
