/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";

export interface SearchBarProps {
  readonly theme: Theme;
  readonly query: string;
  readonly matchCount: number;
  readonly activeOrdinal: number;
  readonly onQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly editing: boolean;
}

function matchLabel(
  query: string,
  matchCount: number,
  activeOrdinal: number,
): string {
  if (!query.trim()) return "";
  if (matchCount <= 0) return "no matches";
  if (activeOrdinal <= 0) return `${matchCount} match${matchCount === 1 ? "" : "es"}`;
  return `${activeOrdinal}/${matchCount}`;
}

export function SearchBar(props: SearchBarProps): ReactNode {
  const {
    theme,
    query,
    matchCount,
    activeOrdinal,
    onQueryChange,
    onSubmit,
    editing,
  } = props;
  const status = matchLabel(query, matchCount, activeOrdinal);

  if (!editing) {
    return (
      <box
        style={{
          flexDirection: "row",
          backgroundColor: theme.rowB,
          paddingLeft: 1,
          paddingRight: 1,
          height: 1,
          alignItems: "center",
          width: "100%",
        }}
      >
        <text
          selectable={false}
          content=" find "
          style={{
            fg: theme.background,
            bg: theme.cyan,
            attributes: TextAttributes.BOLD,
          }}
        />
        <text selectable={false} content=" " />
        <text
          selectable={false}
          content={query.trim() || "…"}
          style={{ fg: theme.foreground, attributes: TextAttributes.BOLD }}
        />
        <text selectable={false} content="  " />
        <text
          selectable={false}
          content={status}
          style={{
            fg: matchCount > 0 ? theme.activity : theme.muted,
            attributes: TextAttributes.BOLD,
          }}
        />
        <text
          selectable={false}
          content="  ·  n/N:next  ·  ^r:edit  ·  esc:close"
          style={{ fg: theme.muted }}
        />
      </box>
    );
  }

  return (
    <box
      style={{
        flexDirection: "row",
        backgroundColor: theme.rowB,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        alignItems: "center",
        width: "100%",
      }}
    >
      <text
        selectable={false}
        content=" ^R "
        style={{
          fg: theme.background,
          bg: theme.cyan,
          attributes: TextAttributes.BOLD,
        }}
      />
      <text selectable={false} content=" " style={{ fg: theme.muted }} />
      <text selectable={false} content="filter " style={{ fg: theme.muted }} />
      <input
        focused
        value={query}
        onInput={onQueryChange}
        onSubmit={onSubmit}
        textColor={theme.foreground}
        backgroundColor={theme.rowB}
        placeholder="search chat…"
        placeholderColor={theme.muted}
        style={{ flexGrow: 1, minWidth: 12 }}
      />
      <text selectable={false} content=" " />
      {status ? (
        <text
          selectable={false}
          content={`${status}  ·  `}
          style={{
            fg: matchCount > 0 ? theme.activity : theme.muted,
            attributes: TextAttributes.BOLD,
          }}
        />
      ) : null}
      <text
        selectable={false}
        content="enter:jump  ·  esc:close"
        style={{ fg: theme.muted }}
      />
    </box>
  );
}
