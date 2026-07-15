/** @jsxImportSource @opentui/react */
/**
 * Renders an `AssistantItem` with classic markdown parity (CHAT-002/003).
 *
 * Classic TUI: magenta `◆ Response` label, then body via `renderMarkdown`
 * (tables, fences, lists, `<br>` → newlines). Body defaults to green so
 * replies read clearly against tool/system chrome.
 *
 * Wrap budget must follow the chat pane width (not full terminal) so markdown
 * tables stay inside the column when the plan/task pane is open.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { AssistantItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { renderMarkdownLines } from "../../rendering/render-markdown-lines.js";

export function AssistantMessage(props: {
  item: AssistantItem;
  theme: Theme;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
  // Prefer shell chat width so tables reflow beside the plan pane; fall back
  // to classic term−chrome when contentWidth is not threaded yet.
  const wrapWidth = Math.max(
    20,
    contentWidth != null ? contentWidth : Math.max(40, termWidth - 8),
  );

  const lines = useMemo(
    () =>
      item.text
        ? renderMarkdownLines(item.text, {
            width: wrapWidth,
            defaultFg: theme.response,
            stripOuterIndent: true,
          })
        : [],
    [item.text, wrapWidth, theme.response],
  );

  return (
    <box id={item.id} style={{ flexDirection: "column", marginBottom: 1, width: "100%" }}>
      <text
        selectable
        style={{
          fg: theme.magenta,
          attributes: TextAttributes.BOLD,
        }}
      >
        ◆ Response{item.streaming ? " …" : ""}
      </text>
      {/* Breathing room under the label (classic Ink blank line after ◆ Response). */}
      <text content=" " selectable />
      {lines.length > 0 ? (
        <box style={{ flexDirection: "column", paddingLeft: 2, width: "100%", marginBottom: 1 }}>
          {lines.map((content, i) => (
            // Body is selectable — drag to select, release copies (OSC 52).
            <text key={i} content={content} selectable />
          ))}
        </box>
      ) : null}
    </box>
  );
}
