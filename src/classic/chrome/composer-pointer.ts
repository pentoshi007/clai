import { displayWidth } from "../render/measure.js";
import { boundaries, type EditorState } from "./editor-model.js";
import type { EditorLayout } from "./editor-view.js";

export interface ComposerPointerView {
  readonly state: EditorState;
  readonly layout: EditorLayout;
  readonly scrollTop: number;
  readonly height: number;
}

export interface ComposerPointerGeometry {
  readonly left: number;
  readonly top: number;
}

export function composerCursorAtPointer(
  view: ComposerPointerView,
  geometry: ComposerPointerGeometry,
  x: number,
  y: number,
): number | undefined {
  const rowIndex = y - geometry.top;
  if (rowIndex < 0 || rowIndex >= view.height || x < geometry.left - 2 || x > geometry.left + view.layout.width) return undefined;
  const row = view.layout.rows[view.scrollTop + rowIndex];
  if (!row) return view.state.text.length;
  const target = Math.max(0, x - geometry.left);
  const bounds = boundaries(row.text);
  let column = 0;
  for (let index = 1; index < bounds.length; index += 1) {
    const from = bounds[index - 1]!;
    const next = column + displayWidth(row.text.slice(from, bounds[index]!));
    if (target < next) return row.start + from;
    column = next;
  }
  return row.end;
}
