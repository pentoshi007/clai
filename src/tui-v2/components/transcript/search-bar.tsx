/** @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import { TextAttributes } from "@opentui/core";
import type { Theme } from "../../../ui-core/rendering/theme.js";
import { fitOneLine } from "../../../ui-core/rendering/pager-chrome.js";
import { matchCounterLabel } from "../../../ui-core/state/text-search.js";

export interface SearchBarProps {
  readonly theme: Theme;
  readonly query: string;
  readonly matchCount: number;
  readonly activeIndex: number;
  readonly editing: boolean;
  readonly width: number;
  readonly onQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
}

const EDITING_HINTS = [
  "↑ prev  ·  ↓ next  ·  ^R prev  ·  enter done  ·  esc clear",
  "↑↓ prev/next  ·  enter done  ·  esc clear",
  "↑↓  ·  enter  ·  esc",
];

const BROWSING_HINTS = [
  "n next  ·  N prev  ·  ^R edit  ·  esc clear",
  "n/N  ·  ^R edit  ·  esc",
  "n/N  ·  esc",
];

export function searchBarHint(editing: boolean, width: number): string {
  return fitOneLine(editing ? EDITING_HINTS : BROWSING_HINTS, Math.max(4, width));
}

export function SearchBar(props: SearchBarProps): ReactNode {
  const { theme, query, matchCount, activeIndex, editing, width } = props;
  const status = matchCounterLabel(query, matchCount, activeIndex);
  const statusColor = matchCount > 0 ? theme.activity : theme.muted;
  const hintWidth = Math.max(4, Math.floor(width * (editing ? 0.42 : 0.5)));
  const hint = searchBarHint(editing, hintWidth);

  return (
    <box
      style={{
        flexDirection: "row",
        backgroundColor: theme.rowB,
        paddingLeft: 1,
        paddingRight: 1,
        height: 1,
        flexShrink: 0,
        alignItems: "center",
        width: "100%",
      }}
    >
      <text
        selectable={false}
        content={editing ? " ^R find " : " find "}
        style={{ fg: theme.background, bg: theme.cyan, attributes: TextAttributes.BOLD, flexShrink: 0 }}
      />
      <text selectable={false} content=" " style={{ flexShrink: 0 }} />
      {editing ? (
        <input
          focused
          value={query}
          onInput={props.onQueryChange}
          onSubmit={props.onSubmit}
          textColor={theme.foreground}
          backgroundColor={theme.rowB}
          placeholder="search chat…"
          placeholderColor={theme.muted}
          style={{ flexGrow: 1, flexShrink: 1, minWidth: 8 }}
        />
      ) : (
        <text
          selectable={false}
          content={query.trim()}
          wrapMode="none"
          style={{ fg: theme.foreground, attributes: TextAttributes.BOLD, flexGrow: 1, flexShrink: 1, minWidth: 1 }}
        />
      )}
      {status ? (
        <text
          selectable={false}
          content={` ${status} `}
          style={{ fg: statusColor, attributes: TextAttributes.BOLD, flexShrink: 0 }}
        />
      ) : null}
      <text selectable={false} content={` ${hint}`} style={{ fg: theme.muted, flexShrink: 0 }} />
    </box>
  );
}
