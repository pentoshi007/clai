import { padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme } from "../render/ink-theme.js";
import { layoutWidth } from "../render/measure.js";
import { boundaries, type EditorState } from "./editor-model.js";

export interface VisualRow {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly hardBreak: boolean;
}

export interface EditorLayout {
  readonly rows: readonly VisualRow[];
  readonly caretRow: number;
  readonly caretColumn: number;
  readonly width: number;
}

export function layoutEditor(state: EditorState, width: number): EditorLayout {
  const budget = Math.max(1, Math.floor(width));
  const rows: VisualRow[] = [];
  let lineStart = 0;

  for (const line of state.text.split("\n")) {
    const bounds = boundaries(line);
    let rowStart = 0;
    let used = 0;
    let lastBreak = -1;

    for (let index = 1; index < bounds.length; index += 1) {
      const from = bounds[index - 1]!;
      const to = bounds[index]!;
      const grapheme = line.slice(from, to);
      const cost = layoutWidth(grapheme);
      if (used + cost > budget && from > rowStart) {
        const cut = lastBreak > rowStart ? lastBreak : from;
        rows.push({
          start: lineStart + rowStart,
          end: lineStart + cut,
          text: line.slice(rowStart, cut),
          hardBreak: false,
        });
        rowStart = cut;
        used = layoutWidth(line.slice(rowStart, from));
        lastBreak = -1;
      }
      used += cost;
      if (grapheme === " ") lastBreak = to;
    }

    rows.push({
      start: lineStart + rowStart,
      end: lineStart + line.length,
      text: line.slice(rowStart),
      hardBreak: true,
    });
    lineStart += line.length + 1;
  }

  const cursor = Math.max(0, Math.min(state.cursor, state.text.length));
  let caretRow = rows.length - 1;
  for (const [index, row] of rows.entries()) {
    if (cursor < row.start) continue;
    if (cursor <= row.end) {
      caretRow = index;
      if (cursor < row.end || row.hardBreak) break;
    }
  }
  const row = rows[caretRow] ?? { start: 0, end: 0, text: "", hardBreak: true };
  const caretColumn = layoutWidth(state.text.slice(row.start, cursor));

  return { rows, caretRow, caretColumn, width: budget };
}

export function scrollTop(layout: EditorLayout, height: number, previousTop = 0): number {
  const rows = Math.max(1, height);
  const max = Math.max(0, layout.rows.length - rows);
  let top = Math.max(0, Math.min(previousTop, max));
  if (layout.caretRow < top) top = layout.caretRow;
  if (layout.caretRow > top + rows - 1) top = layout.caretRow - rows + 1;
  return Math.max(0, Math.min(top, max));
}

export interface RenderEditorInput {
  readonly state: EditorState;
  readonly layout: EditorLayout;
  readonly ink: InkTheme;
  readonly height: number;
  readonly scrollTop: number;
  readonly showCaret: boolean;
  readonly placeholder: string | undefined;
}

export interface RenderedEditor {
  readonly rows: readonly string[];
  readonly clippedAbove: boolean;
  readonly clippedBelow: boolean;
}

export function renderCaretRow(
  ink: InkTheme,
  text: string,
  caretColumn: number,
  showCaret: boolean,
): string {
  if (!showCaret) return text;
  const bounds = boundaries(text);
  let column = 0;
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1]!;
    const to = bounds[index]!;
    const grapheme = text.slice(from, to);
    const cost = layoutWidth(grapheme);
    if (column === caretColumn) {
      return sealStyle(
        `${text.slice(0, from)}${ink.inverse(grapheme)}${text.slice(to)}`,
      );
    }
    column += cost;
  }
  return sealStyle(`${text}${ink.inverse(" ")}`);
}

export function renderEditor(input: RenderEditorInput): RenderedEditor {
  const { layout, ink } = input;
  const height = Math.max(1, input.height);
  const top = Math.max(0, Math.min(input.scrollTop, Math.max(0, layout.rows.length - height)));
  const visible = layout.rows.slice(top, top + height);

  if (input.state.text.length === 0 && input.placeholder !== undefined) {
    const hint = ink.fg("muted", input.placeholder);
    const first = input.showCaret ? `${ink.inverse(" ")}${hint}` : hint;
    return {
      rows: [first, ...Array.from({ length: height - 1 }, () => "")],
      clippedAbove: false,
      clippedBelow: false,
    };
  }

  const rows = visible.map((row, index) => {
    const absolute = top + index;
    const text = absolute === layout.caretRow
      ? renderCaretRow(ink, row.text, layout.caretColumn, input.showCaret)
      : row.text;
    return ink.fg("white", text);
  });
  while (rows.length < height) rows.push("");

  return {
    rows,
    clippedAbove: top > 0,
    clippedBelow: top + height < layout.rows.length,
  };
}

export function moveVisual(
  state: EditorState,
  width: number,
  delta: number,
): EditorState {
  const layout = layoutEditor(state, width);
  const target = layout.caretRow + delta;
  if (target < 0 || target >= layout.rows.length) return state;
  const row = layout.rows[target]!;
  const bounds = boundaries(row.text);
  let column = 0;
  for (let index = 1; index < bounds.length; index += 1) {
    const cost = layoutWidth(row.text.slice(bounds[index - 1]!, bounds[index]!));
    if (column + cost > layout.caretColumn) {
      return { text: state.text, cursor: row.start + bounds[index - 1]! };
    }
    column += cost;
  }
  return { text: state.text, cursor: row.end };
}

export function padRow(text: string, width: number): string {
  return padToWidth(text, width);
}
