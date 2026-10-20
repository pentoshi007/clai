import { CliRenderer, type Renderable } from "@opentui/core";

export interface CellPoint {
  readonly x: number;
  readonly y: number;
}

export function inclusiveSelectionFocus(anchor: CellPoint, focus: CellPoint): CellPoint {
  const forward = focus.y > anchor.y || (focus.y === anchor.y && focus.x > anchor.x);
  return forward ? { x: focus.x + 1, y: focus.y } : focus;
}

let patched = false;

export function patchOpenTuiSelection(): void {
  if (patched) return;
  patched = true;

  const proto = CliRenderer.prototype as unknown as {
    updateSelection(
      this: CliRenderer,
      current: Renderable | undefined,
      x: number,
      y: number,
      options?: { finishDragging?: boolean },
    ): void;
    finishSelection(this: CliRenderer): void;
  };
  const updateSelection = proto.updateSelection;
  proto.updateSelection = function (current, x, y, options) {
    const anchor = this.getSelection()?.anchor;
    const focus = anchor ? inclusiveSelectionFocus(anchor, { x, y }) : { x, y };
    updateSelection.call(this, current, focus.x, focus.y, options);
  };

  const finishSelection = proto.finishSelection;
  proto.finishSelection = function () {
    finishSelection.call(this);
    const selection = this.getSelection();
    if (selection && !selection.isDragging && selection.getSelectedText().length === 0) {
      this.clearSelection();
    }
  };
}
