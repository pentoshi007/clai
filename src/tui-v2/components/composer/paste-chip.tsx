/** @jsxImportSource @opentui/react */

import { useMemo, useRef, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  pastePreviewLines,
  type PastePlaceholderEntry,
} from "../../../ui-core/composer/paste-placeholder.js";

const DOUBLE_CLICK_MS = 400;

export function PastePreview(props: {
  readonly entry: PastePlaceholderEntry;
  readonly theme: Theme;
  readonly width: number;
  readonly maxRows: number;
  readonly onExpand: (id: number) => void;
}): ReactNode {
  const { entry, theme, width, maxRows, onExpand } = props;
  const lastClickAt = useRef(0);
  const preview = useMemo(() => pastePreviewLines(entry.text, 2), [entry]);
  const more = Math.max(0, entry.lines - preview.length);
  const rows = [...preview, ...(more > 0 ? [`…${more} more lines`] : [])]
    .slice(0, Math.max(0, maxRows - 1));
  rows.push("Ctrl+E: nearest paste · double-click to expand");

  return (
    <box
      style={{
        flexDirection: "column",
        width: "100%",
        height: rows.length,
        flexShrink: 0,
        backgroundColor: theme.statusBackground,
      }}
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
      {rows.map((line, index) => (
        <text
          key={index}
          selectable={false}
          content={line.slice(0, Math.max(1, width))}
          style={{
            fg: index === rows.length - 1 ? theme.cyan : theme.muted,
            height: 1,
            attributes: TextAttributes.DIM,
          }}
        />
      ))}
    </box>
  );
}
