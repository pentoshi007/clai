import { BoxRenderable, type CliRenderer, type MouseEvent, type Renderable, type Selection } from "@opentui/core";
import { snapSelectionStart } from "./selection-snap.js";
import type { TableColumn } from "../../../ui-core/rendering/markdown/tables.js";

interface CellFragment {
  readonly column: TableColumn;
  readonly index: number;
}

const fragments = new WeakMap<Renderable, CellFragment>();
const anchors = new WeakMap<Selection, Renderable>();

const gridRows = new WeakSet<Renderable>();

export function registerTableRow(node: Renderable | null): void {
  if (node) gridRows.add(node);
}

function cellAtPress({ target, x }: MouseEvent): Renderable | undefined {
  let row = target;
  while (row && !gridRows.has(row)) row = row.parent;
  if (!row) return undefined;
  const cells = row.getChildren().filter(child => child instanceof BoxRenderable);
  const cell = cells.find(child => x < child.x + child.width) ?? cells.at(-1);
  return cell && x <= cell.x + cell.width ? cell : undefined;
}

export function startPaddedCellSelection(renderer: CliRenderer, event: MouseEvent): boolean {
  if (event.button !== 0 || event.modifiers.ctrl || renderer.getSelection()?.isDragging) return false;
  const cell = cellAtPress(event);
  if (!cell) return false;
  const target = snapSelectionStart<Renderable>([{ root: cell }], event.x, event.y);
  if (target) renderer.startSelection(target.node, target.x, target.y);
  else renderer.clearSelection();
  event.preventDefault();
  return true;
}

export function registerCellFragment(node: Renderable | null, column: TableColumn, index: number): void {
  if (node) fragments.set(node, { column, index });
}

export function anchorTableSelection(selection: Selection, node: Renderable): void {
  if (fragments.has(node)) anchors.set(selection, node);
}

export function tableSelectionFocus(selection: Selection, x: number, y: number) {
  const node = anchors.get(selection);
  if (!node) return undefined;
  const cell = node.parent;
  if (!cell || node.isDestroyed) return null;
  const right = cell.x + cell.width - 1;
  const bottom = cell.y + cell.height - 1;
  if (y < cell.y) return { node, x: cell.x, y: cell.y };
  if (y > bottom) return { node, x: right, y: bottom };
  return { node, x: Math.max(cell.x, Math.min(x, right)), y };
}

export function isCellSelection(selection: Selection | null): selection is Selection {
  return selection !== null && anchors.has(selection);
}

export function selectedCellText(selection: Selection): string | undefined {
  if (!anchors.has(selection)) return undefined;
  let next = 0;
  let text = "";
  for (const node of [...selection.selectedRenderables].sort((a, b) => a.y - b.y)) {
    const part = fragments.get(node);
    if (!part || node.isDestroyed) continue;
    const selected = node.getSelectedText();
    if (!selected) continue;
    if (text) {
      for (let i = next; i <= part.index; i++) text += part.column.pieces[i]!.before;
    }
    next = part.index + 1;
    text += selected;
  }
  return text;
}
