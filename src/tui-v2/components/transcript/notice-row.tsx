/** @jsxImportSource @opentui/react */
/**
 * Renders a `NoticeItem` (CHAT-007, V2-051).
 *
 * Classic Ink: solid WARN / INFO / ERR badge, then body text that wraps in its
 * own column so multi-line errors never paint over the badge.
 */

import { useMemo, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import type { NoticeItem, NoticeLevel } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { wrapAnsiLine } from "../../../ui-core/rendering/markdown.js";
import { LinkableText } from "./linkable-text.js";

/** Fixed-width badge label (see `badge()` below). */
const BADGE_WIDTH = 6;
/** Body box `paddingLeft` under the badge. */
const BODY_PADDING = 1;

function badge(level: NoticeLevel): { label: string; fg: string; bg: string } {
  // Fixed-width labels so wrap indent stays consistent across levels.
  if (level === "warn") return { label: " WARN ", fg: "#FFFFFF", bg: "#D97706" };
  if (level === "error") return { label: " ERR  ", fg: "#FFFFFF", bg: "#B91C1C" };
  return { label: " INFO ", fg: "#FFFFFF", bg: "#334155" };
}

function bodyColor(level: NoticeLevel, theme: Theme): string {
  if (level === "warn") return theme.activity;
  // Error notices are part of the transcript, not just a badge: make the
  // full provider message visibly red so it cannot be mistaken for a status.
  if (level === "error") return theme.diffDel;
  return theme.cyan;
}

export function NoticeRow(props: {
  item: NoticeItem;
  theme: Theme;
  /** Chat-pane columns (plan split/overlay already subtracted). */
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, contentWidth } = props;
  const { width: termWidth } = useTerminalDimensions();
  const b = badge(item.level);
  const fg = bodyColor(item.level, theme);

  // OpenTUI's native wrap never engages for flex-sized text (the wrap width is
  // only set at construction, when flex width is still 0), so long notices get
  // clipped at the terminal edge. Pre-wrap in JS like assistant messages do,
  // then render each line with wrapMode="none". Budget = chat-pane width minus
  // the badge column and the body's left padding.
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
