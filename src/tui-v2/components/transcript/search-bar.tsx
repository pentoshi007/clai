/** @jsxImportSource @opentui/react */
/**
 * Transcript search chrome (CHAT/V2-057).
 *
 * Two modes:
 * 1. Filter open — focused input, type a term, Enter jumps + leaves sticky find.
 * 2. Sticky find (bar closed, query kept) — rendered as a status strip so
 *    n/N / Esc are obvious (same model as the pager).
 */

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
  /** When true, show the focused input. When false, show sticky find strip. */
  readonly editing: boolean;
}

function matchLabel(
  query: string,
  matchCount: number,
  activeOrdinal: number,
): string {
  if (!query.trim()) return "";
  if (matchCount <= 0) return "no matches";
  // Before first Enter, only show total; after, show current/total.
  if (activeOrdinal <= 0) return `${matchCount} match${matchCount === 1 ? "" : "es"}`;
  return `${activeOrdinal}/${matchCount}`;
}

/** Focused filter input while typing a search term. */
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
    // Sticky find strip after Enter — n/N navigate, Esc clears.
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
