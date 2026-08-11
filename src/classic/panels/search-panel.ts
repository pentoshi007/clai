import {
  findMatches,
  nextMatchIndex,
  prevMatchIndex,
  type TranscriptMatch,
} from "../../ui-core/state/transcript-search.js";
import {
  itemSearchText,
  transcriptItems,
  type TranscriptItem,
  type TranscriptState,
} from "../../ui-core/state/transcript-types.js";
import { clipToWidth, padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
import { emptyRow, filterRow } from "./list-rows.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";
import { isPrintable } from "./picker-panel.js";

export interface SearchPanelState {
  readonly query: string;
  readonly cursor: number;
  readonly top: number;
}

export const SEARCH_INITIAL_STATE: SearchPanelState = { query: "", cursor: 0, top: 0 };

export function itemGlyph(ink: InkTheme, item: TranscriptItem): {
  readonly glyph: string;
  readonly token: ThemeToken;
} {
  const glyphs = ink.glyphs;
  switch (item.kind) {
    case "user":
      return { glyph: glyphs.userRail, token: "prompt" };
    case "assistant":
      return { glyph: glyphs.assistantBullet, token: "response" };
    case "thinking":
      return { glyph: glyphs.thinkingGutter, token: "thinking" };
    case "tool":
      return { glyph: glyphs.toolRunning, token: "activity" };
    case "notice":
      return { glyph: glyphs.warning, token: "activity" };
    default:
      return { glyph: glyphs.compacted, token: "muted" };
  }
}

export interface SearchKeyInput {
  readonly state: SearchPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly transcript: TranscriptState;
  readonly rows: number;
}

export function searchKey(input: SearchKeyInput): PanelKeyResult<SearchPanelState> {
  const { state, chord } = input;
  const matches = findMatches(input.transcript, state.query);
  const height = Math.max(1, panelBodyHeight(input.rows) - 1);

  const moveTo = (cursor: number): PanelKeyResult<SearchPanelState> => {
    if (cursor < 0) return handled(state);
    const window = listWindow({
      count: matches.length,
      active: cursor,
      height,
      previousTop: state.top,
    });
    return handled({ ...state, cursor, top: window.top });
  };

  if (chord === "up") return moveTo(prevMatchIndex(matches, state.cursor));
  if (chord === "down") return moveTo(nextMatchIndex(matches, state.cursor));
  if (chord === "enter") {
    const match = matches[state.cursor];
    return match
      ? handled(state, { kind: "search-open", itemId: match.itemId })
      : handled(state);
  }
  if (chord === "backspace") {
    return handled({ ...state, query: state.query.slice(0, -1), cursor: 0, top: 0 });
  }
  if (chord === "ctrl+u") return handled({ ...state, query: "", cursor: 0, top: 0 });
  if (isPrintable(chord, input.text)) {
    return handled({
      ...state,
      query: `${state.query}${input.text ?? ""}`,
      cursor: 0,
      top: 0,
    });
  }
  return unhandled(state);
}

export interface SearchViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly transcript: TranscriptState;
  readonly state: SearchPanelState;
}

const EXCERPT_LEAD = 24;

export function matchExcerpt(
  ink: InkTheme,
  text: string,
  match: TranscriptMatch,
  width: number,
): string {
  const flat = text.replace(/\s+/g, " ");
  const start = Math.max(0, match.start - EXCERPT_LEAD);
  const head = start > 0 ? ink.glyphs.ellipsis : "";
  const before = flat.slice(start, match.start);
  const hit = flat.slice(match.start, match.end);
  const after = flat.slice(match.end);
  const painted = `${head}${before}${ink.inverse(hit)}${after}`;
  return clipToWidth(painted, Math.max(1, width), ink.glyphs.ellipsis);
}

export function searchView(input: SearchViewInput): PanelFrameInput {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const matches = findMatches(input.transcript, state.query);
  const items = new Map(transcriptItems(input.transcript).map((item) => [item.id, item]));

  const window = listWindow({
    count: matches.length,
    active: state.cursor,
    height: Math.max(1, height - 1),
    previousTop: state.top,
  });

  const body: string[] = [filterRow(ink, width, "find", state.query)];
  if (matches.length === 0) {
    body.push(emptyRow(ink, width, state.query === "" ? "type to search" : "no matches"));
  } else {
    for (
      let index = window.top;
      index < Math.min(matches.length, window.top + window.height);
      index += 1
    ) {
      const match = matches[index]!;
      const item = items.get(match.itemId);
      const active = index === state.cursor;
      const marker = ink.style(active ? `${ink.glyphs.promptMark} ` : "  ", {
        fg: "inputBorder",
        bold: active,
      });
      const glyph = item ? itemGlyph(ink, item) : { glyph: ink.glyphs.separator, token: "muted" as ThemeToken };
      const head = ink.style(`${glyph.glyph} `, { fg: glyph.token });
      const excerptWidth = Math.max(1, width - 4);
      const excerpt = item
        ? matchExcerpt(ink, itemSearchText(item), match, excerptWidth)
        : "";
      body.push(sealStyle(`${marker}${head}${padToWidth(excerpt, excerptWidth)}`));
    }
  }

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Find in transcript",
    counter: windowCounter(state.cursor, matches.length),
    hints: [
      `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown}`,
      `${ink.glyphs.enter} open in pager`,
      "esc close",
    ],
    body,
  };
}
