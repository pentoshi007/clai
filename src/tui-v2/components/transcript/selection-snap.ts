
export interface SnapNode {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible?: boolean;
  readonly selectable?: boolean;
  readonly isDestroyed?: boolean;
  getChildren(): readonly unknown[];
}

export interface SnapRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SnapTarget<T extends SnapNode> {
  readonly node: T;
  readonly x: number;
  readonly y: number;
}

function intersectsRows(node: SnapNode, rect: SnapRect | undefined): boolean {
  if (!rect) return true;
  return node.y + node.height > rect.y && node.y < rect.y + rect.height;
}

function collectSelectable<T extends SnapNode>(node: T, rect: SnapRect | undefined, out: T[]): void {
  if (node.visible === false || node.isDestroyed) return;
  if (node.selectable && node.width > 0 && node.height > 0 && intersectsRows(node, rect)) out.push(node);
  for (const child of node.getChildren()) collectSelectable(child as T, rect, out);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function horizontalDistance(node: SnapNode, x: number): number {
  if (x < node.x) return node.x - x;
  const right = node.x + node.width - 1;
  return x > right ? x - right : 0;
}

export interface SnapRegion<T extends SnapNode> {
  readonly root: T | null | undefined;
  readonly viewport?: SnapRect | undefined;
}

export function snapSelectionStart<T extends SnapNode>(
  regions: readonly SnapRegion<T>[],
  x: number,
  y: number,
): SnapTarget<T> | undefined {
  const candidates: T[] = [];
  for (const region of regions) {
    if (region.root) collectSelectable(region.root, region.viewport, candidates);
  }
  if (candidates.length === 0) return undefined;

  let best: { node: T; vertical: number; horizontal: number; above: boolean } | undefined;
  for (const node of candidates) {
    const bottom = node.y + node.height - 1;
    const above = bottom < y;
    const vertical = y < node.y ? node.y - y : above ? y - bottom : 0;
    const horizontal = horizontalDistance(node, x);
    const better =
      !best ||
      vertical < best.vertical ||
      (vertical === best.vertical && (vertical > 0 && above !== best.above ? above : horizontal < best.horizontal));
    if (better) best = { node, vertical, horizontal, above };
  }
  if (!best) return undefined;

  const { node, vertical, above } = best;
  const right = node.x + node.width - 1;
  if (vertical === 0) return { node, x: clamp(x, node.x, right), y };
  if (above) return { node, x: right, y: node.y + node.height - 1 };
  return { node, x: node.x, y: node.y };
}

export function pointInRect(rect: SnapRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

export interface SnapSelectionRenderer<T extends SnapNode> {
  getSelection(): { readonly isDragging: boolean } | null;
  startSelection(node: T, x: number, y: number): void;
}

export interface SnapPress {
  readonly x: number;
  readonly y: number;
  readonly button: number;
  readonly modifiers?: { readonly ctrl?: boolean } | undefined;
  preventDefault?(): void;
}

export function startSnappedSelection<T extends SnapNode>(
  renderer: SnapSelectionRenderer<T>,
  press: SnapPress,
  regions: readonly SnapRegion<T>[],
): boolean {
  if (press.button !== 0 || press.modifiers?.ctrl) return false;
  if (renderer.getSelection()?.isDragging) return false;
  const target = snapSelectionStart(regions, press.x, press.y);
  if (!target) return false;
  renderer.startSelection(target.node, target.x, target.y);
  press.preventDefault?.();
  return true;
}
