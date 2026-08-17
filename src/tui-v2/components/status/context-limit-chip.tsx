/** @jsxImportSource @opentui/react */

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  TextAttributes,
  type InputRenderable,
  type KeyEvent,
} from "@opentui/core";
import type { SessionController } from "../../../app/controllers/session-controller.js";
import type { ContextUsageSnapshot } from "../../../llm/token-usage.js";
import { parseContextLimitInput } from "../../../ui-core/rendering/context-limit.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";

export function ContextLimitChip(props: {
  chip: string;
  theme: Theme;
  exact: boolean;
  usage: ContextUsageSnapshot;
  session: SessionController;
  onEditingStart?: (() => void) | undefined;
  onEditingDone?: (() => void) | undefined;
}): ReactNode {
  const {
    chip,
    theme,
    exact,
    usage,
    session,
    onEditingStart,
    onEditingDone,
  } = props;
  const inputRef = useRef<InputRenderable | null>(null);
  const editingRef = useRef(false);
  const onEditingDoneRef = useRef(onEditingDone);
  onEditingDoneRef.current = onEditingDone;
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [clickExpanded, setClickExpanded] = useState(false);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    const microtask = Promise.resolve().then(() => inputRef.current?.focus());
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      void microtask;
      cancelAnimationFrame(frame);
    };
  }, [editing]);

  useEffect(
    () => () => {
      if (editingRef.current) onEditingDoneRef.current?.();
    },
    [],
  );

  const open = (): void => {
    editingRef.current = true;
    onEditingStart?.();
    setValue(usage.contextLimit > 0 ? String(usage.contextLimit) : "");
    setEditing(true);
    setClickExpanded(false);
    setHovered(false);
  };
  const submit = (): void => {
    const limit = parseContextLimitInput(value);
    if (limit === null) return;
    session.setContextLimitTokens(limit);
    editingRef.current = false;
    setEditing(false);
    onEditingDone?.();
  };
  const reset = (): void => {
    session.setContextLimitTokens(undefined);
    setValue("");
    editingRef.current = false;
    setEditing(false);
    onEditingDone?.();
  };

  const onKeyDown = (key: KeyEvent): void => {
    if (key.name === "escape") {
      key.preventDefault();
      editingRef.current = false;
      setEditing(false);
      onEditingDone?.();
    }
  };

  if (editing) {
    return (
      <box style={{ flexDirection: "row", alignItems: "center", flexShrink: 0 }}>
        <text content="ctx limit " style={{ fg: theme.muted }} />
        <input
          ref={(input: InputRenderable | null) => {
            inputRef.current = input;
            input?.focus();
          }}
          focused
          value={value}
          onInput={setValue}
          onSubmit={submit}
          onKeyDown={onKeyDown}
          textColor={theme.foreground}
          backgroundColor={theme.selection}
          placeholder="1m or 253k"
          placeholderColor={theme.muted}
          style={{ width: 12, minWidth: 8 }}
        />
        <box
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            reset();
          }}
          style={{ backgroundColor: theme.chip, paddingLeft: 1, paddingRight: 1 }}
        >
          <text
            selectable={false}
            content="reset"
            style={{ fg: theme.white, attributes: TextAttributes.BOLD }}
          />
        </box>
      </box>
    );
  }

  const shown = hovered || clickExpanded;
  const label = shown ? "edit ctx limit" : chip;
  return (
    <box
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        open();
      }}
      onMouseOver={() => {
        setHovered(true);
        setClickExpanded(false);
      }}
      onMouseOut={() => {
        setHovered(false);
        setClickExpanded(false);
      }}
      style={{
        flexDirection: "row",
        flexShrink: 0,
        backgroundColor: shown ? theme.selection : theme.background,
        paddingLeft: 1,
        paddingRight: 1,
      }}
    >
      <text
        selectable={false}
        content={label}
        style={{
          fg: shown ? theme.white : theme.aqua,
          attributes: TextAttributes.BOLD,
        }}
      />
    </box>
  );
}

