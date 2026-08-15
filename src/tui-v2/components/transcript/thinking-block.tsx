/** @jsxImportSource @opentui/react */
/**
 * Renders a `ThinkingItem` (CHAT-006, V2-053).
 *
 * Live stream: while the model is still reasoning (`item.streaming`), the body
 * is always shown so the user sees live progress — regardless of the global
 * thinking toggle (Ctrl+T). After the block is finalized, the body follows the
 * global Ctrl+T toggle (or a per-block override from clicking the header).
 *
 * Placement: thinking rows always precede the ◆ Response / tool cards for
 * the same model step (agent emits thinking-block before assistant-message
 * and tool-call). Violet accent distinguishes reasoning from green replies.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { renderColumns } from "../../../ui-core/rendering/text-width.js";
import type { ThinkingItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { selectableRowStyle } from "./selectable-line.js";
import { liveThinkingDisplay } from "../../../ui-core/rendering/thinking-tail.js";
import { wrapPagerLine } from "../../../ui-core/rendering/pager-chrome.js";

/** Body indent inside the block (paddingLeft below). */
const BODY_INDENT = 2;

export function ThinkingBlock(props: {
  item: ThinkingItem;
  theme: Theme;
  expanded: boolean;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
  onToggle: () => void;
}): ReactNode {
  const { item, theme, expanded, contentWidth, onToggle } = props;
  const { width: termWidth } = useTerminalDimensions();
  const showBody = expanded || item.streaming;
  const onMouseUp = (event: MouseEvent): void => {
    event.preventDefault();
    onToggle();
  };

  const header = item.streaming
    ? "✦ thinking…"
    : showBody
      ? "▾ thinking"
      : "▸ thinking · ctrl+t or click to view";

  const wrapWidth = Math.max(
    20,
    (contentWidth != null ? contentWidth : Math.max(40, termWidth - 8)) -
      BODY_INDENT,
  );
  const bodyLines = useMemo(() => {
    if (!showBody || !item.content) return [];
    const source = item.streaming
      ? liveThinkingDisplay(item.content)
      : item.content;
    return source
      .replace(/\r\n/g, "\n")
      .split("\n")
      .flatMap((line) => wrapPagerLine(line, wrapWidth))
      .map((line) => line + " ".repeat(Math.max(0, wrapWidth - renderColumns(line))));
  }, [showBody, item.content, item.streaming, wrapWidth]);

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
      {showBody && bodyLines.length > 0 ? (
        <box
          style={{
            flexDirection: "column",
            paddingLeft: BODY_INDENT,
            width: wrapWidth + BODY_INDENT,
            overflow: "hidden",
            // Paints the indent strip too, so nothing shows through the gap
            // between the pane edge and the first glyph.
            backgroundColor: theme.background,
          }}
        >
          {bodyLines.map((content, index) => (
            <text
              key={index}
              content={content}
              selectable
              wrapMode="none"
              style={{
                ...selectableRowStyle(theme.background),
                width: wrapWidth,
                fg: theme.thinking,
                attributes: TextAttributes.ITALIC,
              }}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}
