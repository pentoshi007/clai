/** @jsxImportSource @opentui/react */
/**
 * Renders a `ThinkingItem` (CHAT-006, V2-053).
 *
 * Live stream: while the model is still reasoning (`item.streaming`), the body
 * is always shown — same as the classic TUI's thinking preview. After the
 * block is finalized, the body follows the global Ctrl+T toggle (or a per-
 * block override from clicking the header).
 *
 * Placement: thinking rows always precede the ◆ Response / tool cards for
 * the same model step (agent emits thinking-block before assistant-message
 * and tool-call). Violet accent distinguishes reasoning from green replies.
 */

import type { ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import type { ThinkingItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";

export function ThinkingBlock(props: {
  item: ThinkingItem;
  theme: Theme;
  expanded: boolean;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, expanded, onToggle } = props;
  // Always show live content while streaming; after finalize, honor toggle.
  const showBody = item.streaming || expanded;
  const onMouseUp = (event: MouseEvent): void => {
    event.preventDefault();
    // Only allow collapse/expand once the block is complete.
    if (item.streaming) return;
    onToggle();
  };

  const header = item.streaming
    ? "✦ thinking…"
    : showBody
      ? "▾ thinking"
      : "▸ thinking · ctrl+t or click to view";

  return (
    <box id={item.id} style={{ flexDirection: "column", marginBottom: 1, width: "100%" }}>
      <box onMouseUp={onMouseUp} style={{ flexDirection: "row" }}>
        <text
          selectable
          style={{
            fg: theme.thinking,
            attributes: TextAttributes.ITALIC,
          }}
        >
          {header}
        </text>
      </box>
      {showBody && item.content ? (
        <box style={{ flexDirection: "column", paddingLeft: 2 }}>
          <text
            selectable
            style={{
              fg: theme.thinking,
              attributes: TextAttributes.ITALIC,
            }}
          >
            {item.content}
          </text>
        </box>
      ) : null}
    </box>
  );
}
