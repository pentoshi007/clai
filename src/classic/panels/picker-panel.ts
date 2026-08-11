import type { PickerRequest } from "../../ui-core/controllers/overlay-controller.js";
import {
  activeIndex,
  filterPickerOptions,
  type PickerOption,
} from "../../ui-core/rendering/picker-filter.js";
import type { InkTheme } from "../render/ink-theme.js";
import { emptyRow, filterRow, listRow, listSubRow } from "./list-rows.js";
import { listWindow, windowCounter } from "./list-window.js";
import { panelBodyHeight, panelBodyWidth, type PanelFrameInput } from "./panel-frame.js";
import { handled, unhandled, type PanelKeyResult } from "./panel-effect.js";

export interface PickerPanelState {
  readonly query: string;
  readonly cursor: number;
  readonly top: number;
}

export function pickerInitialState(request: PickerRequest): PickerPanelState {
  return { query: "", cursor: activeIndex(request.options), top: 0 };
}

export function pickerRowHeight(request: PickerRequest): 1 | 2 {
  return request.twoLine === true || request.historyStyle === true ? 2 : 1;
}

export function pickerFiltered(
  request: PickerRequest,
  query: string,
): readonly PickerOption[] {
  return filterPickerOptions(request.options, query, {
    searchDescription: request.searchDescription ?? request.historyStyle === true,
  });
}

export interface PickerKeyInput {
  readonly request: PickerRequest;
  readonly state: PickerPanelState;
  readonly chord: string;
  readonly text?: string | undefined;
  readonly rows: number;
}

export function isPrintable(chord: string, text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  if (chord.includes("+")) return false;
  return [...text].every((char) => char >= " " && char !== "\x7f");
}

function itemCapacity(request: PickerRequest, rows: number, query: string): number {
  const body = panelBodyHeight(rows) - (query.length > 0 ? 1 : 0);
  return Math.max(1, Math.floor(Math.max(1, body) / pickerRowHeight(request)));
}

export function pickerKey(input: PickerKeyInput): PanelKeyResult<PickerPanelState> {
  const { request, state, chord } = input;
  const filtered = pickerFiltered(request, state.query);
  const count = filtered.length;
  const capacity = itemCapacity(request, input.rows, state.query);

  const move = (delta: number): PanelKeyResult<PickerPanelState> => {
    if (count === 0) return handled(state);
    const cursor = (state.cursor + delta + count) % count;
    const window = listWindow({
      count,
      active: cursor,
      height: capacity,
      previousTop: state.top,
    });
    return handled({ ...state, cursor, top: window.top });
  };

  if (chord === "up") return move(-1);
  if (chord === "down") return move(1);
  if (chord === "pageup") return move(-capacity);
  if (chord === "pagedown") return move(capacity);
  if (chord === "enter") {
    const option = filtered[Math.min(state.cursor, Math.max(0, count - 1))];
    return option
      ? handled(state, { kind: "picker-select", value: option.value })
      : handled(state);
  }
  if (chord === "backspace") {
    return handled({ ...state, query: state.query.slice(0, -1), cursor: 0, top: 0 });
  }
  if (chord === "ctrl+u") {
    return handled({ ...state, query: "", cursor: 0, top: 0 });
  }
  if (request.rowAction && chord === request.rowAction.chord) {
    const option = filtered[Math.min(state.cursor, Math.max(0, count - 1))];
    return option
      ? handled(state, { kind: "picker-row-action", value: option.value })
      : handled(state);
  }
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

export interface PickerViewInput {
  readonly ink: InkTheme;
  readonly columns: number;
  readonly rows: number;
  readonly request: PickerRequest;
  readonly state: PickerPanelState;
}

export interface PickerView {
  readonly frame: PanelFrameInput;
  readonly top: number;
  readonly count: number;
}

function pickerHints(ink: InkTheme, request: PickerRequest): readonly string[] {
  const accept = request.historyStyle === true ? "resume" : "select";
  const hints = [
    `${ink.glyphs.scrollUp}${ink.glyphs.scrollDown} move`,
    `${ink.glyphs.enter} ${accept}`,
  ];
  if (request.rowAction) hints.push(request.rowAction.hint);
  hints.push("esc cancel", "type to filter");
  return hints;
}

export function pickerView(input: PickerViewInput): PickerView {
  const { ink, request, state } = input;
  const width = panelBodyWidth(input.columns);
  const filtered = pickerFiltered(request, state.query);
  const count = filtered.length;
  const twoLine = pickerRowHeight(request) === 2;
  const bodyHeight = panelBodyHeight(input.rows);
  const filterRows = state.query.length > 0 ? 1 : 0;
  const capacity = itemCapacity(request, input.rows, state.query);

  const window = listWindow({
    count,
    active: state.cursor,
    height: capacity,
    previousTop: state.top,
  });

  const body: string[] = [];
  if (filterRows === 1) body.push(filterRow(ink, width, "filter", state.query));

  if (count === 0) {
    body.push(emptyRow(ink, width));
  } else {
    const visible = filtered.slice(window.top, window.top + window.height);
    visible.forEach((option, offset) => {
      const index = window.top + offset;
      const active = index === state.cursor;
      body.push(
        listRow({
          ink,
          width,
          columns: input.columns,
          label: option.active === true ? `${option.label} ${ink.glyphs.separator} current` : option.label,
          description: twoLine ? undefined : option.description,
          active,
        }),
      );
      if (twoLine) {
        body.push(
          listSubRow({
            ink,
            width,
            text: option.description ?? "",
            active,
          }),
        );
      }
    });
  }

  return {
    frame: {
      ink,
      columns: input.columns,
      rows: input.rows,
      title: request.title,
      counter: windowCounter(state.cursor, count),
      hints: pickerHints(ink, request),
      body: body.slice(0, Math.max(0, bodyHeight)),
    },
    top: window.top,
    count,
  };
}
