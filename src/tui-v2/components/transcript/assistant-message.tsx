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

import { useMemo, useRef, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { ColorMode } from "../../../app/ports/terminal-port.js";
import type { AssistantItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import {
  EMPTY_MARKDOWN_STREAM_CACHE,
  type MarkdownStreamCache,
} from "../../../ui-core/rendering/streaming-markdown.js";
import { renderStyledStreamingMarkdown } from "../../rendering/styled-markdown.js";
import { selectableRowStyle } from "./selectable-line.js";

/** Body indent under the ◆ Response label (paddingLeft below). */
const BODY_INDENT = 2;

export function AssistantMessage(props: {
  item: AssistantItem;
  theme: Theme;
  colorMode: ColorMode;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, colorMode, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
  // Prefer shell chat width so tables reflow beside the plan pane; fall back
  // to classic term−chrome when contentWidth is not threaded yet. The body
  // renders inside paddingLeft: BODY_INDENT, so the wrap budget must exclude
  // the indent or full-length lines paint past the chat column's right edge.
  const wrapWidth = Math.max(
    20,
    (contentWidth != null ? contentWidth : Math.max(40, termWidth - 8)) -
      BODY_INDENT,
  );

  const cacheRef = useRef<MarkdownStreamCache>(EMPTY_MARKDOWN_STREAM_CACHE);
  const lines = useMemo(() => {
    const rendered = renderStyledStreamingMarkdown({
      text: item.text,
      streaming: item.streaming,
      options: {
        width: wrapWidth,
        defaultFg: theme.response,
        stripOuterIndent: true,
        theme,
        colorMode,
      },
      cache: cacheRef.current,
    });
    cacheRef.current = rendered.cache;
    return rendered.lines;
  }, [item.text, item.streaming, wrapWidth, theme, colorMode]);

  // Hide fence-only / empty streaming rows so raw tool JSON never flashes as
  // a hollow "◆ Response …" before tool cards land.
  if (!item.text.trim() && item.streaming) return null;
  if (!item.text.trim() && lines.length === 0) return null;

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
        <box style={{ flexDirection: "column", paddingLeft: BODY_INDENT, width: "100%", marginBottom: 1 }}>
          {lines.map((content, i) => (
            // Body is selectable — drag to select, release copies (OSC 52).
            // Never pass null/undefined content — OpenTUI crashes on text.chunks.
            // Pre-wrapped by renderMarkdownLines — disable OpenTUI re-wrap so
            // mid-chunk styles (bold/cyan) never drop to default green on wrap.
            <text
              key={i}
              content={content ?? " "}
              selectable
              wrapMode="none"
              // Full-row hit target — shrink-wrapped text was nearly
              // unselectable — and an opaque fill so short rows (prose, and
              // content-sized code panels) repaint the cells to their right.
              style={selectableRowStyle(theme.background)}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}
