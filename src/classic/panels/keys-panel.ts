import { MAX_PROVIDER_KEYS } from "../../llm/key-rotation.js";
import type { KeysEditorRequest } from "../../ui-core/controllers/overlay-controller.js";
import type { InkTheme } from "../render/ink-theme.js";
import { listRow } from "./list-rows.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";
import { isPrintable } from "./picker-panel.js";

const MASK_CHAR = "•";

export interface KeysPanelRow {
  readonly slotId: string | undefined;
  readonly masked: string | undefined;
  readonly value: string;
  readonly disabled: boolean;
}

export interface KeysPanelState {
  readonly rows: readonly KeysPanelRow[];
  readonly cursor: number;
  readonly activeIndex: number;
  readonly editing: boolean;
  readonly draft: string;
  readonly top: number;
}

export function keysInitialState(request: KeysEditorRequest): KeysPanelState {
  return {
    rows: request.initialKeys.map((slot) => ({
      slotId: slot.id,
      masked: slot.masked,
      value: "",
      disabled: slot.disabled === true,
    })),
    cursor: 0,
    activeIndex: Math.max(0, request.activeIndex ?? 0),
    editing: false,
    draft: "",
    top: 0,
  };
}

export function keysItemLabel(request: KeysEditorRequest): string {
  return request.itemLabel ?? "API key";
}

/** Endpoint-URL variants reuse this panel unmasked; secrets stay masked. */
export function keysRevealed(request: KeysEditorRequest): boolean {
  const label = request.itemLabel;
  return label !== undefined && !/key|secret|token|password/i.test(label);
}

export function keysCanAdd(state: KeysPanelState): boolean {
  return state.rows.length < MAX_PROVIDER_KEYS;
}

export function keysRowCount(state: KeysPanelState): number {
  return state.rows.length + (keysCanAdd(state) ? 1 : 0);
}

export interface KeysKeyInput {
  readonly state: KeysPanelState;
  readonly request: KeysEditorRequest;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly rows: number;
}

export function keysKey(input: KeysKeyInput): PanelKeyResult<KeysPanelState> {
  const { state, chord } = input;
  const count = keysRowCount(state);
  const height = Math.max(1, panelBodyHeight(input.rows));
  const isAddRow = state.cursor >= state.rows.length;

  if (state.editing) {
    if (chord === "enter") {
      const value = state.draft.trim();
      if (value === "") return handled({ ...state, editing: false, draft: "" });
      const rows = isAddRow
        ? [...state.rows, { slotId: undefined, masked: undefined, value, disabled: false }]
        : state.rows.map((row, index) =>
            index === state.cursor ? { ...row, value } : row,
          );
      return handled({ ...state, rows, editing: false, draft: "" });
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
    return handled({ ...state, editing: true, draft: "" });
  }
  if (chord === "space") {
    if (isAddRow) return handled(state);
    return handled({ ...state, activeIndex: state.cursor });
  }
  if (chord === "d") {
    if (isAddRow) return handled(state);
    const rows = state.rows.map((row, index) =>
      index === state.cursor ? { ...row, disabled: !row.disabled } : row,
    );
    return handled({ ...state, rows });
  }
  if (chord === "ctrl+d") {
    if (isAddRow || state.rows.length === 0) return handled(state);
    const rows = state.rows.filter((_, index) => index !== state.cursor);
    return handled({
      ...state,
      rows,
      cursor: Math.min(state.cursor, rows.length),
      activeIndex: Math.max(0, Math.min(state.activeIndex, rows.length - 1)),
    });
  }
  if (chord === "ctrl+r") {
    return handled(state, { kind: "keys", answer: { action: "reset" } });
  }
  if (chord === "ctrl+s") {
    return handled(state, {
      kind: "keys",
      answer: {
        action: "save",
        rows: state.rows.map((row) =>
          row.slotId === undefined
            ? { value: row.value, disabled: row.disabled }
            : { slotId: row.slotId, value: row.value, disabled: row.disabled },
        ),
        activeIndex: state.activeIndex,
      },
    });
  }
  return unhandled(state);
}

export interface KeysViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: KeysEditorRequest;
  readonly state: KeysPanelState;
}

function rowValue(
  row: KeysPanelRow,
  reveal: boolean,
  editing: boolean,
  draft: string,
): string {
  if (editing) return reveal ? draft : MASK_CHAR.repeat(draft.length);
  if (row.value !== "") return reveal ? row.value : MASK_CHAR.repeat(row.value.length);
  return row.masked ?? "";
}

export function keysView(input: KeysViewInput): PanelFrameInput {
  const { ink, state } = input;
  const width = panelBodyWidth(input.columns);
  const height = panelBodyHeight(input.rows);
  const count = keysRowCount(state);
  const reveal = keysRevealed(input.request);
  const window = listWindow({
    count,
    active: state.cursor,
    height: Math.max(1, height),
    previousTop: state.top,
  });

  const body: string[] = [];
  for (let index = window.top; index < Math.min(count, window.top + window.height); index += 1) {
    const active = index === state.cursor;
    const addRow = index >= state.rows.length;
    const editing = active && state.editing;
    if (addRow) {
      body.push(
        listRow({
          ink,
          width,
          columns: input.columns,
          label: `    ${state.rows.length + 1}  ${editing ? state.draft : `+ add ${keysItemLabel(input.request)}`}`,
          active,
          labelToken: editing ? "foreground" : "muted",
        }),
      );
      continue;
    }
    const row = state.rows[index]!;
    const sticky =
      index === state.activeIndex ? ink.fg("activity", ink.glyphs.sticky) : ink.fg("muted", ink.glyphs.stickyOff);
    const disabledTag = row.disabled ? `  ${ink.fg("muted", "· disabled")}` : "";
    body.push(
      listRow({
        ink,
        width,
        columns: input.columns,
        label: `${sticky} ${index + 1}  ${rowValue(row, reveal, editing, state.draft)}${disabledTag}`,
        active,
        trailing: ink.fg("muted", ink.glyphs.remove),
      }),
    );
  }

  return {
    ink,
    columns: input.columns,
    rows: input.rows,
    title: `${input.request.provider} ${ink.glyphs.separator} ${keysItemLabel(input.request)}s`,
    counter: windowCounter(state.cursor, count),
    hints: [
      `${ink.glyphs.enter} edit`,
      "space set active",
      "d disable",
      "^D remove",
      "^S save",
      "^R reset",
    ],
    body,
  };
}
