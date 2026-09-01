/** @jsxImportSource @opentui/react */

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

const BODY_INDENT = 2;

export function AssistantMessage(props: {
  item: AssistantItem;
  theme: Theme;
  colorMode: ColorMode;
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, colorMode, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
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
      {}
      <text content=" " selectable />
      {lines.length > 0 ? (
        <box style={{ flexDirection: "column", paddingLeft: BODY_INDENT, width: "100%", marginBottom: 1 }}>
          {lines.map((content, i) => (
            <text
              key={i}
              content={content ?? " "}
              selectable
              wrapMode="none"
              style={selectableRowStyle(theme.background)}
            />
          ))}
        </box>
      ) : null}
    </box>
  );
}
