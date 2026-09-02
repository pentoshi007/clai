/** @jsxImportSource @opentui/react */

import { useMemo, useState, type ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { UserItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { wrapUserPrompt } from "../../../ui-core/rendering/user-message-wrap.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";
import { DiffActionButton } from "./file-diff-card.js";

const COLLAPSED_PROMPT_LINES = 6;

export function UserMessage(props: {
  item: UserItem;
  theme: Theme;
  onOpen: (prompt: string) => void;
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, onOpen, contentWidth } = props;
  const [expanded, setExpanded] = useState(false);
  const { width: termWidth } = useTerminalDimensionsContext();
  const wrapBudget = Math.max(
    20,
    contentWidth != null ? contentWidth : Math.max(40, termWidth - 8),
  );
  const lines = useMemo(
    () => wrapUserPrompt(item.text, wrapBudget),
    [item.text, wrapBudget],
  );

  const click = useClickWithoutDrag(() => onOpen(item.text));
  const canToggle = lines.length > COLLAPSED_PROMPT_LINES;
  const visibleLines = expanded ? lines : lines.slice(0, COLLAPSED_PROMPT_LINES);

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "row",
        marginBottom: 1,
        borderColor: theme.userBorder,
        backgroundColor: theme.statusBackground,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <text
        selectable
        style={{
          fg: theme.white,
          bg: theme.prompt,
          attributes: TextAttributes.BOLD,
          flexShrink: 0,
        }}
      >
        {" YOU "}
      </text>
      <text content=" " selectable style={{ flexShrink: 0 }} />
      <box
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          flexDirection: "column",
          width: "100%",
        }}
      >
        {visibleLines.map((line, i) => (
          <LinkableText
            key={i}
            text={line}
            theme={theme}
            selectable
            wrapMode="none"
          />
        ))}
        {canToggle ? (
          <box
            style={{ flexDirection: "row", alignItems: "center", marginTop: 1 }}
          >
            <text selectable={false} style={{ fg: theme.muted, flexGrow: 1 }}>
              {expanded ? "full prompt" : `+${lines.length - visibleLines.length} more lines`}
            </text>
            <DiffActionButton
              label={expanded ? "collapse" : "expand"}
              theme={theme}
              onClick={() => setExpanded((value) => !value)}
            />
          </box>
        ) : null}
      </box>
    </box>
  );
}
