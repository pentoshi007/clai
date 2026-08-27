import { padToWidth, sealStyle } from "../render/ansi-text.js";
import type { InkTheme, ThemeToken } from "../render/ink-theme.js";
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

export interface EditorSpan {
  readonly start: number;
  readonly end: number;
  readonly color?: ThemeToken | undefined;
}

export interface RenderEditorInput {
  readonly state: EditorState;
  readonly layout: EditorLayout;
  readonly ink: InkTheme;
  readonly height: number;
  readonly scrollTop: number;
  readonly showCaret: boolean;
  readonly placeholder: string | undefined;
  readonly accentSpans?: readonly EditorSpan[] | undefined;
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

function paintAccentText(
  ink: InkTheme,
  text: string,
  origin: number,
  spans: readonly EditorSpan[],
): string {
  if (text.length === 0) return "";
  const end = origin + text.length;
  const overlapping = spans
    .filter((span) => span.end > origin && span.start < end)
    .sort((a, b) => a.start - b.start);
  if (overlapping.length === 0) return ink.fg("white", text);
  const pieces: string[] = [];
  let cursor = origin;
  for (const span of overlapping) {
    const from = Math.max(span.start, origin);
    const to = Math.min(span.end, end);
    if (to <= cursor) continue;
    if (from > cursor) {
      pieces.push(ink.fg("white", text.slice(cursor - origin, from - origin)));
    }
    pieces.push(
      ink.style(text.slice(from - origin, to - origin), {
        fg: span.color ?? "activity",
        bold: true,
      }),
    );
    cursor = to;
  }
  if (cursor < end) pieces.push(ink.fg("white", text.slice(cursor - origin)));
  return pieces.join("");
}

function paintAccentRow(
  ink: InkTheme,
  row: VisualRow,
  spans: readonly EditorSpan[],
): string {
  return sealStyle(paintAccentText(ink, row.text, row.start, spans));
}

function paintCaretRow(
  ink: InkTheme,
  row: VisualRow,
  caretColumn: number,
  showCaret: boolean,
  spans: readonly EditorSpan[],
): string {
  if (!showCaret) return paintAccentRow(ink, row, spans);
  const text = row.text;
  const bounds = boundaries(text);
  let column = 0;
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1]!;
    const to = bounds[index]!;
    if (column === caretColumn) {
      return sealStyle(
        paintAccentText(ink, text.slice(0, from), row.start, spans) +
          ink.inverse(text.slice(from, to)) +
          paintAccentText(ink, text.slice(to), row.start + to, spans),
      );
    }
    column += layoutWidth(text.slice(from, to));
  }
  return sealStyle(
    paintAccentText(ink, text, row.start, spans) + ink.inverse(" "),
  );
}

export function renderEditor(input: RenderEditorInput): RenderedEditor {
  const { layout, ink } = input;
  const height = Math.max(1, input.height);
  const top = Math.max(0, Math.min(input.scrollTop, Math.max(0, layout.rows.length - height)));
  const visible = layout.rows.slice(top, top + height);

  if (input.state.text.length === 0 && input.placeholder !== undefined) {
    const hint = input.placeholder;
    let first: string;
    if (input.showCaret) {
      const bounds = boundaries(hint);
      const to = bounds.length > 1 ? bounds[1]! : hint.length;
      first = sealStyle(
        `${ink.inverse(hint.slice(0, to))}${ink.fg("muted", hint.slice(to))}`,
      );
    } else {
      first = ink.fg("muted", hint);
    }
    return {
      rows: [first, ...Array.from({ length: height - 1 }, () => "")],
      clippedAbove: false,
      clippedBelow: false,
    };
  }

  const accentSpans = input.accentSpans ?? [];
  const rows = visible.map((row, index) => {
    const absolute = top + index;
    return absolute === layout.caretRow
      ? paintCaretRow(ink, row, layout.caretColumn, input.showCaret, accentSpans)
      : paintAccentRow(ink, row, accentSpans);
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
