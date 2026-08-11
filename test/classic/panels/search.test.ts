import { describe, expect, it } from "vitest";
import { panelFrameRows } from "../../../src/classic/panels/panel-frame.js";
import {
  searchKey,
  searchView,
  SEARCH_INITIAL_STATE,
  type SearchPanelState,
} from "../../../src/classic/panels/search-panel.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptItem,
  type TranscriptState,
} from "../../../src/ui-core/state/transcript-types.js";
import { colorInk, createHarness, ink, rowsOf } from "./harness.js";

function transcript(items: readonly TranscriptItem[]): TranscriptState {
  return {
    ...EMPTY_TRANSCRIPT_STATE,
    order: items.map((item) => item.id),
    byId: new Map(items.map((item) => [item.id, item])),
  };
}

const STATE = transcript([
  { id: "a", kind: "assistant", sequence: 1, text: "I'll read the route handler for pagination" } as TranscriptItem,
  { id: "b", kind: "user", sequence: 2, text: "add pagination to the users endpoint" } as TranscriptItem,
  { id: "c", kind: "tool", sequence: 3, name: "shell.exec", status: "ok", argsDisplay: "npm test", summary: "pagination contract holds" } as TranscriptItem,
]);

function render(state: SearchPanelState, theme = ink) {
  const frame = searchView({ ink: theme, columns: 80, rows: 7, transcript: STATE, state });
  return { frame, rows: rowsOf(panelFrameRows(frame).rows) };
}

function press(state: SearchPanelState, chord: string, text?: string) {
  return searchKey({ state, chord, text, transcript: STATE, rows: 7 });
}

describe("search rows", () => {
  it("shows the find row and prompts before a query", () => {
    const { frame, rows } = render(SEARCH_INITIAL_STATE);
    expect(frame.title).toBe("Find in transcript");
    expect(rows[1]).toContain("find:");
    expect(rows[2]).toContain("type to search");
    expect(frame.hints).toEqual(["▲▼", "⏎ open in pager", "esc close"]);
  });

  it("lists one row per match with its block glyph", () => {
    const { frame, rows } = render({ query: "pagination", cursor: 0, top: 0 });
    expect(frame.counter).toBe("1/3");
    expect(rows[1]).toContain("find: pagination");
    expect(rows[2]).toContain("◆");
    expect(rows[3]).toContain("▌");
    expect(rows[4]).toContain("●");
  });

  it("paints the match inverse", () => {
    const rows = panelFrameRows(
      render({ query: "pagination", cursor: 0, top: 0 }, colorInk).frame,
    ).rows;
    expect(rows[2]).toContain("\x1b[7m");
  });

  it("reports no matches", () => {
    const { frame, rows } = render({ query: "zzz", cursor: 0, top: 0 });
    expect(frame.counter).toBeUndefined();
    expect(rows[2]).toContain("no matches");
  });
});

describe("search keys", () => {
  it("builds the query and clears it", () => {
    let state = SEARCH_INITIAL_STATE;
    for (const char of "pag") state = press(state, char, char).state;
    expect(state.query).toBe("pag");
    state = press(state, "backspace").state;
    expect(state.query).toBe("pa");
    state = press(state, "ctrl+u").state;
    expect(state.query).toBe("");
  });

  it("wraps through matches with the shared navigators", () => {
    const state: SearchPanelState = { query: "pagination", cursor: 0, top: 0 };
    expect(press(state, "down").state.cursor).toBe(1);
    expect(press(state, "up").state.cursor).toBe(2);
  });

  it("opens the selected block and closes the panel", () => {
    const harness = createHarness();
    harness.transcript = STATE;
    harness.panels.openSearch();
    for (const char of "pagination") harness.press(char, char);
    harness.press("down");
    expect(harness.press("enter")).toBe(true);
    expect(harness.revealed).toEqual(["b"]);
    expect(harness.panels.getSnapshot().search).toBeUndefined();
  });

  it("is inactive until it is opened", () => {
    const harness = createHarness();
    harness.transcript = STATE;
    expect(harness.press("down")).toBe(false);
    harness.panels.openSearch();
    expect(harness.press("down")).toBe(true);
    harness.panels.closeSearch();
    expect(harness.press("down")).toBe(false);
  });
});
