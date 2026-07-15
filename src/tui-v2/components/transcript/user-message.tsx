/** @jsxImportSource @opentui/react */
/** Renders a `UserItem` (CHAT-001, V2-051). */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { UserItem } from "../../state/transcript-types.js";
import type { Theme } from "../../rendering/theme.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

export function UserMessage(props: {
  item: UserItem;
  theme: Theme;
  onOpen: (prompt: string) => void;
}): ReactNode {
  const { item, theme, onOpen } = props;
  // Text is selectable for drag-copy; click (no drag) opens prompt actions.
  const click = useClickWithoutDrag(() => onOpen(item.text));

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
        }}
      >
        {" YOU "}
      </text>
      <text content=" " selectable />
      <box style={{ flexGrow: 1 }}>
        <LinkableText text={item.text} theme={theme} selectable />
      </box>
    </box>
  );
}
