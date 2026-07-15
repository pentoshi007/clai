/** @jsxImportSource @opentui/react */
/**
 * Renders a `NoticeItem` (CHAT-007, V2-051).
 *
 * Classic Ink: solid WARN / INFO / ERR badge, then body text that wraps in its
 * own column so multi-line errors never paint over the badge.
 */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { NoticeItem, NoticeLevel } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { LinkableText } from "./linkable-text.js";

function badge(level: NoticeLevel): { label: string; fg: string; bg: string } {
  // Fixed-width labels so wrap indent stays consistent across levels.
  if (level === "warn") return { label: " WARN ", fg: "#FFFFFF", bg: "#D97706" };
  if (level === "error") return { label: " ERR  ", fg: "#FFFFFF", bg: "#B91C1C" };
  return { label: " INFO ", fg: "#FFFFFF", bg: "#334155" };
}

function bodyColor(level: NoticeLevel, theme: Theme): string {
  if (level === "warn") return theme.activity;
  if (level === "error") return theme.mode;
  return theme.cyan;
}

export function NoticeRow(props: { item: NoticeItem; theme: Theme }): ReactNode {
  const { item, theme } = props;
  const b = badge(item.level);
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
          paddingLeft: 1,
          minWidth: 0,
        }}
      >
        <LinkableText text={item.text} theme={theme} fg={bodyColor(item.level, theme)} selectable />
      </box>
    </box>
  );
}
