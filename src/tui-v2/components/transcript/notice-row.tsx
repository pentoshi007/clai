/** @jsxImportSource @opentui/react */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { NoticeItem, NoticeLevel } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { wrapAnsiLine } from "../../../ui-core/rendering/markdown.js";
import { LinkableText } from "./linkable-text.js";

const BADGE_WIDTH = 6;
const BODY_PADDING = 1;

function badge(level: NoticeLevel): { label: string; fg: string; bg: string } {
  if (level === "warn") return { label: " WARN ", fg: "#FFFFFF", bg: "#D97706" };
  if (level === "error") return { label: " ERR  ", fg: "#FFFFFF", bg: "#B91C1C" };
  return { label: " INFO ", fg: "#FFFFFF", bg: "#334155" };
}

function bodyColor(level: NoticeLevel, theme: Theme): string {
  if (level === "warn") return theme.activity;
  if (level === "error") return theme.diffDel;
  return theme.cyan;
}

export function NoticeRow(props: {
  item: NoticeItem;
  theme: Theme;
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensionsContext();
  const b = badge(item.level);
  const fg = bodyColor(item.level, theme);

  const wrapWidth = Math.max(
    20,
    (contentWidth != null ? contentWidth : Math.max(40, termWidth - 8)) -
      BADGE_WIDTH -
      BODY_PADDING,
  );
  const lines = useMemo(
    () => wrapAnsiLine(item.text, wrapWidth),
    [item.text, wrapWidth],
  );

  return (
    <box
      id={item.id}
      style={{
        marginBottom: 1,
        flexDirection: "row",
        width: "100%",
        alignItems: "flex-start",
      }}
    >
      <text
        selectable
        style={{
          fg: b.fg,
          bg: b.bg,
          attributes: TextAttributes.BOLD,
          flexShrink: 0,
        }}
      >
        {b.label}
      </text>
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          flexDirection: "column",
          paddingLeft: BODY_PADDING,
          minWidth: 0,
        }}
      >
        {lines.map((content, i) => (
          <LinkableText
            key={i}
            text={content}
            theme={theme}
            fg={fg}
            selectable
            wrapMode="none"
          />
        ))}
      </box>
    </box>
  );
}
