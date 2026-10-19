/** @jsxImportSource @opentui/react */

import { useMemo, useState, type ReactNode } from "react";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import { useTerminalDimensionsContext } from "../../hooks/terminal-dimensions.js";
import type { UserItem } from "../../../ui-core/state/transcript-types.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { wrapUserPrompt } from "../../../ui-core/rendering/user-message-wrap.js";
import { LinkableText } from "./linkable-text.js";
import { useClickWithoutDrag } from "./use-click-without-drag.js";

const USER_PROMPT_COLLAPSE_ROWS = 6;
const USER_PROMPT_KEPT_ROWS = USER_PROMPT_COLLAPSE_ROWS - 1;
const USER_BADGE = " YOU ";

export function UserMessage(props: {
  item: UserItem;
  theme: Theme;
  onOpen: (prompt: string) => void;
  contentWidth?: number | undefined;
}): ReactNode {
  const { item, theme, onOpen, contentWidth } = props;
  const [expanded, setExpanded] = useState(false);
  const { width: termWidth } = useTerminalDimensionsContext();
  const wrapBudget = Math.max(20, contentWidth ?? Math.max(40, termWidth - 8));
  const lines = useMemo(
    () => wrapUserPrompt(item.text.trimEnd(), wrapBudget),
    [item.text, wrapBudget],
  );
  const click = useClickWithoutDrag(() => onOpen(item.text));
  const collapsible = lines.length > USER_PROMPT_COLLAPSE_ROWS;
  const visibleLines = collapsible && !expanded ? lines.slice(0, USER_PROMPT_KEPT_ROWS) : lines;

  return (
    <box
      id={item.id}
      border
      borderStyle="rounded"
      style={{
        flexDirection: "row",
        width: "100%",
        flexShrink: 0,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        borderColor: theme.userBorder,
        backgroundColor: theme.statusBackground,
      }}
      onMouseDown={click.onMouseDown}
      onMouseUp={click.onMouseUp}
    >
      <box style={{ flexDirection: "row", flexShrink: 0, height: 1 }}>
        <text
          selectable={false}
          content={USER_BADGE}
          style={{ fg: theme.white, bg: theme.prompt, attributes: TextAttributes.BOLD }}
        />
        <text selectable={false} content=" " />
      </box>
      <box style={{ flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }}>
        {visibleLines.map((line, index) => (
          <LinkableText key={index} text={line} theme={theme} selectable wrapMode="none" />
        ))}
        {collapsible ? (
          <PromptDisclosure
            id={`${item.id}-disclosure`}
            theme={theme}
            expanded={expanded}
            hiddenLines={lines.length - visibleLines.length}
            onToggle={() => setExpanded((value) => !value)}
          />
        ) : null}
      </box>
    </box>
  );
}

function PromptDisclosure(props: {
  id: string;
  theme: Theme;
  expanded: boolean;
  hiddenLines: number;
  onToggle: () => void;
}): ReactNode {
  const { id, theme, expanded, hiddenLines, onToggle } = props;
  const [hovered, setHovered] = useState(false);
  const label = expanded ? "- click to collapse" : "+ click to expand";
  const detail = expanded ? "" : ` (${hiddenLines} more ${hiddenLines === 1 ? "line" : "lines"})`;
  const swallow = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
      <box
        id={id}
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseDown={(event: MouseEvent) => {
          if (event.button !== 0) return;
          swallow(event);
          onToggle();
        }}
        onMouseUp={swallow}
        style={{ flexShrink: 0, height: 1 }}
      >
        <text
          selectable={false}
          content={label}
          style={{
            fg: hovered ? theme.cyan : theme.hint,
            attributes: hovered ? TextAttributes.BOLD : TextAttributes.NONE,
          }}
        />
      </box>
      {detail ? <text selectable={false} content={detail} style={{ fg: theme.hint }} /> : null}
    </box>
  );
}
