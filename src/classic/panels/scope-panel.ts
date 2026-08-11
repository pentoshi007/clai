import type { ScopeEditorRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { listRow } from "./list-rows.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";
import { isPrintable } from "./picker-panel.js";

export interface ScopePanelState {
  readonly targets: readonly string[];
  readonly cursor: number;
  readonly editing: boolean;
  readonly draft: string;
  readonly top: number;
}

export function scopeInitialState(request: ScopeEditorRequest): ScopePanelState {
  return {
    targets: [...request.initialTargets],
    cursor: 0,
    editing: false,
    draft: "",
    top: 0,
  };
}

export function scopeRowCount(state: ScopePanelState): number {
  return state.targets.length + 1;
}

export interface ScopeKeyInput {
  readonly state: ScopePanelState;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly rows: number;
}

export function scopeKey(input: ScopeKeyInput): PanelKeyResult<ScopePanelState> {
  const { state, chord } = input;
  const count = scopeRowCount(state);
  const height = Math.max(1, panelBodyHeight(input.rows));
  const isAddRow = state.cursor >= state.targets.length;

  if (state.editing) {
    if (chord === "enter") {
      const value = state.draft.trim();
      if (value === "") return handled({ ...state, editing: false, draft: "" });
      const targets = isAddRow
        ? [...state.targets, value]
        : state.targets.map((entry, index) => (index === state.cursor ? value : entry));
      return handled({ ...state, targets, editing: false, draft: "", cursor: state.cursor });
    }
    if (chord === "escape") return handled({ ...state, editing: false, draft: "" });
    if (chord === "backspace") return handled({ ...state, draft: state.draft.slice(0, -1) });
    if (chord === "ctrl+u") return handled({ ...state, draft: "" });
    if (isPrintable(chord, input.text)) {
      return handled({ ...state, draft: `${state.draft}${input.text ?? ""}` });
    }
    return handled(state);
  }

  if (chord === "up" || chord === "down") {
    const cursor = (state.cursor + (chord === "up" ? -1 : 1) + count) % count;
    const window = listWindow({ count, active: cursor, height, previousTop: state.top });
    return handled({ ...state, cursor, top: window.top });
  }
  if (chord === "enter") {
    return handled({
      ...state,
      editing: true,
      draft: isAddRow ? "" : (state.targets[state.cursor] ?? ""),
    });
  }
  if (chord === "ctrl+d") {
    if (isAddRow || state.targets.length === 0) return handled(state);
    const targets = state.targets.filter((_, index) => index !== state.cursor);
    return handled({
      ...state,
      targets,
      cursor: Math.min(state.cursor, targets.length),
    });
  }
  if (chord === "ctrl+r") {
    return handled({ ...state, targets: [], cursor: 0, top: 0 });
  }
  if (chord === "ctrl+s") {
    return handled(state, { kind: "scope", targets: [...state.targets] });
  }
  return unhandled(state);
}

export interface ScopeViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly state: ScopePanelState;
}

export function scopeView(input: ScopeViewInput): PanelFrameInput {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const count = scopeRowCount(state);
  const window = listWindow({
    count,
    active: state.cursor,
    height: Math.max(1, height),
    previousTop: state.top,
  });

  const body: string[] = [];
  for (let index = window.top; index < Math.min(count, window.top + window.height); index += 1) {
    const active = index === state.cursor;
    const addRow = index >= state.targets.length;
    const editing = active && state.editing;
    const label = addRow
      ? editing
        ? `${state.targets.length + 1}  ${state.draft}`
        : `${state.targets.length + 1}  + add target`
      : `${index + 1}  ${editing ? state.draft : (state.targets[index] ?? "")}`;
    body.push(
      listRow({
        ink,
        width,
        columns: input.columns,
        label,
        active,
        labelToken: addRow && !editing ? "muted" : "foreground",
        trailing: addRow ? undefined : ink.fg("muted", ink.glyphs.remove),
      }),
    );
  }

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: "Engagement scope",
    counter: windowCounter(state.cursor, count),
    hints: [
      `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown}`,
      `${ink.glyphs.enter} edit`,
      "^D remove",
      "^S save",
      "^R clear",
      "esc",
    ],
    body,
  };
}
