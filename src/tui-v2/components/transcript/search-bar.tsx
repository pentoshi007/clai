/** @jsxImportSource @opentui/react */
/**
 * Transcript search input (CHAT/V2-057). Purely a text field plus a match
 * counter; query matching and index navigation live in the renderer-
 * independent `transcript-search.ts` and are owned by `TranscriptView`, which
 * also handles Escape (global key handling can't be typed on `<input>`'s
 * React props — see that component for why).
 */

import type { ReactNode } from "react";
import type { Theme } from "../../rendering/theme.js";

export interface SearchBarProps {
  readonly theme: Theme;
  readonly query: string;
  readonly matchCount: number;
  readonly activeOrdinal: number;
  readonly onQueryChange: (value: string) => void;
  readonly onSubmit: () => void;
}

export function SearchBar(props: SearchBarProps): ReactNode {
  const { theme, query, matchCount, activeOrdinal, onQueryChange, onSubmit } = props;
  const status = matchCount > 0 ? `${activeOrdinal}/${matchCount}` : query ? "no matches" : "";
  return (
    <box style={{ flexDirection: "row", backgroundColor: theme.statusBackground, paddingLeft: 1 }}>
      <text style={{ fg: theme.muted }}>type:filter  </text>
      <input
        focused
        value={query}
        onInput={onQueryChange}
        onSubmit={onSubmit}
        textColor={theme.foreground}
        backgroundColor={theme.statusBackground}
        style={{ flexGrow: 1 }}
      />
      <text style={{ fg: theme.muted }}>
        {" "}
        {status}  ·  enter:next  ·  esc:close
      </text>
    </box>
  );
}
