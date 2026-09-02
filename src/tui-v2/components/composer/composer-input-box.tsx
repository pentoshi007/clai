/** @jsxImportSource @opentui/react */

import { type RefObject, type ReactNode } from "react";
import {
  TextAttributes,
  type KeyEvent,
  type MouseEvent,
  type TextareaRenderable,
} from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";

export function ComposerInputBox(props: {
  readonly theme: Theme;
  readonly editorRef: RefObject<TextareaRenderable | null>;
  readonly focused: boolean;
  readonly running?: boolean | undefined;
  readonly width: number;
  readonly boxHeight: number;
  readonly metaShown: string;
  readonly chromeFg: string;
  readonly keyBindings: never;
  readonly onMouseDown: () => void;
  readonly onMouseScroll: (event: MouseEvent) => void;
  readonly onSubmit: () => void;
  readonly onContentChange: () => void;
  readonly onCursorChange: () => void;
  readonly onKeyDown: (key: KeyEvent) => void;
}): ReactNode {
  const {
    theme,
    editorRef,
    focused,
    running,
    width,
    boxHeight,
    metaShown,
    chromeFg,
    keyBindings,
    onMouseDown,
    onMouseScroll,
    onSubmit,
    onContentChange,
    onCursorChange,
    onKeyDown,
  } = props;

  return (
    <box
      border
      borderStyle="heavy"
      {...(metaShown
        ? {
            title: ` ${metaShown} `,
            titleAlignment: "right" as const,
            titleColor: theme.muted,
          }
        : {})}
      style={{
        height: boxHeight,
        width,
        borderColor: chromeFg,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: "row",
        minWidth: 0,
      }}
      onMouseDown={onMouseDown}
      onMouseScroll={onMouseScroll}
    >
      <text
        content="❯ "
        style={{
          fg: chromeFg,
          width: 2,
          flexShrink: 0,
          attributes: focused ? TextAttributes.BOLD : TextAttributes.DIM,
        }}
      />
      <textarea
        ref={editorRef}
        focused={focused}
        selectable
        selectionBg={theme.selection}
        selectionFg={theme.white}
        placeholder={
          running
            ? "type to queue a message…"
            : `ask anything · @ file or folder · Shift+Enter newline · ⇧⇥ mode`
        }
        placeholderColor={theme.muted}
        textColor={theme.foreground}
        backgroundColor={theme.statusBackground}
        cursorColor={chromeFg}
        keyBindings={keyBindings}
        wrapMode="word"
        onSubmit={onSubmit}
        onContentChange={onContentChange}
        onCursorChange={onCursorChange}
        onKeyDown={onKeyDown}
        onMouseDown={onMouseDown}
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
  );
}
