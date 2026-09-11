import type { PickerRequest } from "../../ui-core/controllers/overlay-controller.js";
import {
  activeIndex,
  filterPickerOptions,
  type PickerOption,
} from "../../ui-core/rendering/picker-filter.js";
import type { InkTheme } from "../render/ink-theme.js";
import { emptyRow, filterRow } from "./list-rows.js";
import { windowCounter } from "./list-window.js";
import { layoutPickerOptions, pickerScrollTop } from "../../ui-core/rendering/picker-layout.js";
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
  readonly columns?: number | undefined;
}

export function isPrintable(chord: string, text: string | undefined): boolean {
  if (text === undefined || text.length === 0) return false;
  if (chord.includes("+")) return false;
  return [...text].every((char) => char >= " " && char !== "\x7f");
}

function itemCapacity(rows: number, query: string): number {
  const height = panelBodyHeight(rows);
  return Math.max(1, height - (query.length > 0 && height > 1 ? 1 : 0));
}

export function pickerKey(input: PickerKeyInput): PanelKeyResult<PickerPanelState> {
  const { request, state, chord } = input;
  const filtered = pickerFiltered(request, state.query);
  const count = filtered.length;
  const capacity = itemCapacity(input.rows, state.query);
  const items = layoutPickerOptions(filtered, panelBodyWidth(input.columns ?? 80), pickerRowHeight(request) === 2);

  const move = (delta: number): PanelKeyResult<PickerPanelState> => {
    if (count === 0) return handled(state);
    const cursor = ((state.cursor + delta) % count + count) % count;
    return handled({ ...state, cursor, top: pickerScrollTop(items, cursor, capacity, items[cursor]?.top ?? 0) });
  };

  const scroll = (delta: number): PanelKeyResult<PickerPanelState> => {
    const last = items.at(-1);
    const top = Math.max(0, Math.min(state.top + delta, (last ? last.top + last.height : 0) - capacity));
    const current = items[state.cursor];
    const cursor = current && current.top + current.height > top && current.top < top + capacity
      ? state.cursor
      : Math.max(0, items.findIndex((item) => item.top + item.height > top));
    return handled({ ...state, cursor, top });
  };

  if (chord === "up") return move(-1);
  if (chord === "down") return move(1);
  if (chord === "pageup") return scroll(-capacity);
  if (chord === "pagedown") return scroll(capacity);
  if (chord === "left") return scroll(-1);
  if (chord === "right") return scroll(1);
  if (chord === "home") return move(-state.cursor);
  if (chord === "end") return move(count - 1 - state.cursor);
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
  hints.push("pg↑↓ scroll");
  return hints;
}

export function pickerView(input: PickerViewInput): PickerView {
  const { ink, request, state } = input;
  const width = panelBodyWidth(input.columns);
  const filtered = pickerFiltered(request, state.query);
  const count = filtered.length;
  const twoLine = pickerRowHeight(request) === 2;
  const bodyHeight = panelBodyHeight(input.rows);
  const filterRows = state.query.length > 0 && bodyHeight > 1 ? 1 : 0;
  const capacity = itemCapacity(input.rows, state.query);
  const items = layoutPickerOptions(filtered, width, twoLine);
  const cursor = Math.min(state.cursor, Math.max(0, count - 1));
  const top = pickerScrollTop(items, cursor, capacity, state.top);

  const body: string[] = [];
  if (filterRows === 1) body.push(filterRow(ink, width, "filter", state.query));

  if (count === 0) {
    body.push(emptyRow(ink, width));
  } else {
    items.forEach((item, index) => {
      if (item.top + item.height <= top || item.top >= top + capacity) return;
      const active = index === cursor;
      item.lines.forEach((line, offset) => {
        if (item.top + offset < top || item.top + offset >= top + capacity) return;
        const marker = width >= 3 ? active && offset === 0 ? `${ink.glyphs.promptMark} ` : "  " : "";
        body.push(ink.style(`${marker}${line.text}`, {
          fg: line.description ? "muted" : active ? "accent" : "foreground",
          bold: active,
        }));
      });
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
    top,
    count,
  };
}
