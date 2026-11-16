import {
  RGBA,
  TextAttributes,
  TextBufferRenderable,
  type OptimizedBuffer,
  type Renderable,
} from "@opentui/core";
import stringWidth from "string-width";
import { searchRanges } from "../../../ui-core/state/text-search.js";
import type { Theme } from "../../../ui-core/rendering/theme.js";

const CHAR_FLAG_MASK = 0xc0000000;
const CHAR_FLAG_CONTINUATION = 0xc0000000;
const OPAQUE_CLUSTER = "\ufffc";

export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenCell {
  readonly x: number;
  readonly y: number;
}

export interface RenderedOccurrence {
  readonly renderable: TextBufferRenderable;
  readonly row: number;
  readonly column: number;
}

export interface SearchHighlightColors {
  readonly match: { readonly fg: RGBA; readonly bg: RGBA };
  readonly active: { readonly fg: RGBA; readonly bg: RGBA };
}

export function searchHighlightColors(theme: Theme): SearchHighlightColors {
  return {
    match: { fg: RGBA.fromHex(theme.searchMatchText), bg: RGBA.fromHex(theme.searchMatch) },
    active: { fg: RGBA.fromHex(theme.searchActiveText), bg: RGBA.fromHex(theme.searchActive) },
  };
}

function intersects(rect: ScreenRect, other: ScreenRect): boolean {
  return rect.x < other.x + other.width
    && other.x < rect.x + rect.width
    && rect.y < other.y + other.height
    && other.y < rect.y + rect.height;
}

function rectOf(node: Renderable): ScreenRect {
  return { x: node.screenX, y: node.screenY, width: node.width, height: node.height };
}

export function searchableTexts(root: Renderable, clip?: ScreenRect): TextBufferRenderable[] {
  const found: TextBufferRenderable[] = [];
  const visit = (node: Renderable): void => {
    if (node.isDestroyed || !node.visible) return;
    if (clip && node !== root && !intersects(rectOf(node), clip)) return;
    if (node instanceof TextBufferRenderable) {
      if (node.selectable) found.push(node);
      return;
    }
    for (const child of node.getChildren()) visit(child as Renderable);
  };
  visit(root);
  return found;
}

function visualPosition(node: TextBufferRenderable, line: number, column: number): { row: number; column: number } {
  const info = node.lineInfo;
  const sources = info?.lineSources ?? [];
  const starts = info?.lineStartCols ?? [];
  let row = -1;
  for (let index = 0; index < sources.length; index += 1) {
    if (sources[index] !== line) {
      if (row >= 0) break;
      continue;
    }
    if ((starts[index] ?? 0) <= column) row = index;
    else break;
  }
  if (row < 0) return { row: line, column };
  return { row, column: column - (starts[row] ?? 0) };
}

export function renderedOccurrences(root: Renderable, pattern: RegExp, limit = Number.POSITIVE_INFINITY): RenderedOccurrence[] {
  const occurrences: RenderedOccurrence[] = [];
  for (const node of searchableTexts(root)) {
    const lines = node.plainText.split("\n");
    for (let line = 0; line < lines.length; line += 1) {
      const text = lines[line]!;
      for (const range of searchRanges(text, pattern)) {
        const position = visualPosition(node, line, stringWidth(text.slice(0, range.start)));
        occurrences.push({ renderable: node, row: position.row, column: position.column });
        if (occurrences.length >= limit) return occurrences;
      }
    }
  }
  return occurrences;
}

export function renderedOccurrence(root: Renderable, pattern: RegExp, occurrence: number): RenderedOccurrence | undefined {
  const found = renderedOccurrences(root, pattern, Math.max(0, occurrence) + 1);
  return found[Math.min(Math.max(0, occurrence), found.length - 1)];
}

export function occurrenceCell(hit: RenderedOccurrence): ScreenCell {
  return { x: hit.renderable.screenX + hit.column, y: hit.renderable.screenY + hit.row };
}

interface RowText {
  readonly text: string;
  readonly cells: readonly number[];
}

function rowText(buffer: OptimizedBuffer, y: number, from: number, to: number): RowText {
  const chars = buffer.buffers.char;
  const width = buffer.width;
  let text = "";
  const cells: number[] = [];
  for (let x = from; x < to; x += 1) {
    const code = chars[y * width + x]! >>> 0;
    const flags = (code & CHAR_FLAG_MASK) >>> 0;
    if (flags === CHAR_FLAG_CONTINUATION) continue;
    const char = flags !== 0 ? OPAQUE_CLUSTER : code === 0 ? " " : String.fromCodePoint(code);
    for (let unit = 0; unit < char.length; unit += 1) cells.push(x);
    text += char;
  }
  return { text, cells };
}

function paintCells(
  buffer: OptimizedBuffer,
  y: number,
  from: number,
  to: number,
  colors: { readonly fg: RGBA; readonly bg: RGBA },
  bold: boolean,
): void {
  const { fg, bg, attributes } = buffer.buffers;
  const width = buffer.width;
  for (let x = from; x < to; x += 1) {
    const index = y * width + x;
    fg.set(colors.fg.buffer, index * 4);
    bg.set(colors.bg.buffer, index * 4);
    if (bold) attributes[index] = (attributes[index]! | TextAttributes.BOLD) >>> 0;
  }
}

export interface SearchHighlightInput {
  readonly buffer: OptimizedBuffer;
  readonly root: Renderable;
  readonly viewport: ScreenRect;
  readonly pattern: RegExp;
  readonly active: ScreenCell | undefined;
  readonly colors: SearchHighlightColors;
}

export function paintSearchHighlights(input: SearchHighlightInput): number {
  const { buffer, viewport, pattern, active, colors } = input;
  const clip: ScreenRect = {
    x: Math.max(0, viewport.x),
    y: Math.max(0, viewport.y),
    width: Math.min(buffer.width, viewport.x + viewport.width) - Math.max(0, viewport.x),
    height: Math.min(buffer.height, viewport.y + viewport.height) - Math.max(0, viewport.y),
  };
  if (clip.width <= 0 || clip.height <= 0) return 0;
  let painted = 0;
  for (const node of searchableTexts(input.root, clip)) {
    const left = Math.max(clip.x, node.screenX);
    const right = Math.min(clip.x + clip.width, node.screenX + node.width);
    const top = Math.max(clip.y, node.screenY);
    const bottom = Math.min(clip.y + clip.height, node.screenY + node.height);
    if (left >= right) continue;
    for (let y = top; y < bottom; y += 1) {
      const row = rowText(buffer, y, left, right);
      for (const range of searchRanges(row.text, pattern)) {
        const from = row.cells[range.start];
        if (from === undefined) continue;
        const to = row.cells[range.end] ?? right;
        const current = active !== undefined && active.y === y && active.x === from;
        paintCells(buffer, y, from, to, current ? colors.active : colors.match, current);
        painted += 1;
      }
    }
  }
  return painted;
}
