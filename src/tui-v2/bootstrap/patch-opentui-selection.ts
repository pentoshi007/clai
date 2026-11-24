import { CliRenderer, type Renderable } from "@opentui/core";
import { anchorTableSelection, tableSelectionFocus } from "../components/transcript/table-cell-selection.js";

export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

export function inclusiveSelectionFocus(anchor: CellPoint, focus: CellPoint): CellPoint {
  const forward = focus.y > anchor.y || (focus.y === anchor.y && focus.x > anchor.x);
  return forward ? { x: focus.x + 1, y: focus.y } : focus;
}

let patched = false;
const selectionPress = new WeakMap<NonNullable<ReturnType<CliRenderer["getSelection"]>>, CellPoint>();

function mousePosition(renderer: CliRenderer): CellPoint {
  return (renderer as unknown as { readonly _latestPointer: CellPoint })._latestPointer;
}

export function patchOpenTuiSelection(): void {
  if (patched) return;
  patched = true;

  const proto = CliRenderer.prototype as unknown as {
    startSelection: CliRenderer["startSelection"];
    updateSelection(
      this: CliRenderer,
      current: Renderable | undefined,
      x: number,
      y: number,
      options?: { finishDragging?: boolean },
    ): void;
    finishSelection(this: CliRenderer): void;
  };
  const startSelection = proto.startSelection;
  proto.startSelection = function (this: CliRenderer, renderable, x, y) {
    startSelection.call(this, renderable, x, y);
    const selection = this.getSelection();
    if (!selection) return;
    selectionPress.set(selection, { ...mousePosition(this) });
    anchorTableSelection(selection, renderable);
  };

  const updateSelection = proto.updateSelection;
  proto.updateSelection = function (current, x, y, options) {
    const selection = this.getSelection();
    if (!selection) return;
    const cell = tableSelectionFocus(selection, x, y);
    if (cell === null) return this.clearSelection();
    const focus = inclusiveSelectionFocus(selection.anchor, cell ?? { x, y });
    updateSelection.call(this, cell?.node ?? current, focus.x, focus.y, options);
  };

  const finishSelection = proto.finishSelection;
  proto.finishSelection = function () {
    const selection = this.getSelection();
    if (!selection?.isDragging) return;
    const press = selectionPress.get(selection);
    const release = mousePosition(this);
    const moved = press && (press.x !== release.x || press.y !== release.y);
    if (moved || !selection.isStart) this.requestSelectionUpdate();
    finishSelection.call(this);
    if (this.getSelection() === selection && selection.getSelectedText().length === 0) {
      this.clearSelection();
    }
  };
}
