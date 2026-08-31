/** @jsxImportSource @opentui/react */

import { useRef, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  pastePreviewLines,
  type PastePlaceholderEntry,
} from "../../../ui-core/composer/paste-placeholder.js";

const DOUBLE_CLICK_MS = 400;

export function PasteChipRow(props: {
  readonly entries: readonly PastePlaceholderEntry[];
  readonly theme: Theme;
  readonly width: number;
  readonly onExpand: (id: number) => void;
}): ReactNode {
  const { entries, theme, width, onExpand } = props;
  if (entries.length === 0) return null;

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
        marginBottom: 0,
      }}
    >
      {entries.map((entry) => (
        <PasteChip
          key={entry.id}
          entry={entry}
          theme={theme}
          width={width}
          onExpand={onExpand}
        />
      ))}
    </box>
  );
}

function PasteChip(props: {
  readonly entry: PastePlaceholderEntry;
  readonly theme: Theme;
  readonly width: number;
  readonly onExpand: (id: number) => void;
}): ReactNode {
  const { entry, theme, width, onExpand } = props;
  const [hovered, setHovered] = useState(false);
  const lastClickAt = useRef(0);

  const preview = pastePreviewLines(entry.text, 2);
  const more = Math.max(0, entry.lines - preview.length);
  const popW = Math.max(24, Math.min(width, 72));

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        flexShrink: 0,
        alignItems: "flex-start",
      }}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        if (now - lastClickAt.current <= DOUBLE_CLICK_MS) {
          lastClickAt.current = 0;
          onExpand(entry.id);
          return;
        }
        lastClickAt.current = now;
      }}
    >
      {hovered ? (
        <box
          border
          borderStyle="rounded"
          style={{
            flexDirection: "column",
            width: popW,
            borderColor: theme.cyan,
            backgroundColor: theme.statusBackground,
            paddingLeft: 1,
            paddingRight: 1,
            marginBottom: 0,
            flexShrink: 0,
          }}
        >
          {preview.map((line, i) => (
            <text
              key={i}
              selectable={false}
              content={line}
              style={{
                fg: theme.foreground,
                attributes: TextAttributes.NONE,
              }}
            />
          ))}
          {more > 0 ? (
            <text
              selectable={false}
              content={`…${more} more line${more === 1 ? "" : "s"}`}
              style={{ fg: theme.muted, attributes: TextAttributes.DIM }}
            />
          ) : null}
          <text
            selectable={false}
            content="double-click to expand"
            style={{
              fg: theme.cyan,
              attributes: TextAttributes.DIM,
            }}
          />
        </box>
      ) : null}
      <box
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexShrink: 0,
          backgroundColor: hovered ? theme.selection : theme.background,
          paddingLeft: 1,
          paddingRight: 1,
        }}
      >
        <text
          selectable={false}
          content={entry.label}
          style={{
            fg: theme.cyan,
            bg: hovered ? theme.selection : theme.background,
            attributes: TextAttributes.BOLD,
          }}
        />
      </box>
    </box>
  );
}
