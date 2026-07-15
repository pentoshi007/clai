/**
 * Renderer-independent semantic text coordinates used by pane selection.
 *
 * Anchors point at stable domain block ids and UTF-16 source offsets rather
 * than viewport cells, so wrapping, resizing, and virtualized rows cannot
 * change what an existing selection means.
 */

import { detectLinks } from "../rendering/link-detector.js";

export const SEMANTIC_BLOCK_SEPARATOR = "\n\n";

export interface SemanticBlock {
  readonly id: string;
  readonly text: string;
}

export interface SemanticDocument {
  readonly blocks: readonly SemanticBlock[];
}

export interface SemanticAnchor {
  readonly blockId: string;
  readonly offset: number;
}

export interface SemanticRange {
  readonly anchor: SemanticAnchor;
  readonly focus: SemanticAnchor;
}

export type SemanticMovement =
  | "left"
  | "right"
  | "word-left"
  | "word-right"
  | "line-start"
  | "line-end"
  | "up"
  | "down";

export function normalizeSemanticDocument(document: SemanticDocument): SemanticDocument {
  const ids = new Set<string>();
  const blocks = document.blocks.map((block) => {
    if (!block.id) throw new Error("semantic blocks require a stable id");
    if (ids.has(block.id)) throw new Error(`duplicate semantic block id: ${block.id}`);
    ids.add(block.id);
    return { id: block.id, text: block.text };
  });
  return { blocks };
}

export function documentStart(document: SemanticDocument): SemanticAnchor | undefined {
  const block = document.blocks[0];
  return block ? { blockId: block.id, offset: 0 } : undefined;
}

export function documentEnd(document: SemanticDocument): SemanticAnchor | undefined {
  const block = document.blocks.at(-1);
  return block ? { blockId: block.id, offset: block.text.length } : undefined;
}

export function clampSemanticAnchor(
  document: SemanticDocument,
  anchor: SemanticAnchor,
  missing: "start" | "end" = "start",
): SemanticAnchor | undefined {
  const index = indexOfBlock(document, anchor.blockId);
  if (index < 0) return missing === "start" ? documentStart(document) : documentEnd(document);
  const block = document.blocks[index]!;
  return { blockId: block.id, offset: Math.max(0, Math.min(anchor.offset, block.text.length)) };
}

export function compareSemanticAnchors(
  document: SemanticDocument,
  left: SemanticAnchor,
  right: SemanticAnchor,
): number {
  const leftIndex = indexOfBlock(document, left.blockId);
  const rightIndex = indexOfBlock(document, right.blockId);
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return left.offset - right.offset;
}

export function semanticRangeText(document: SemanticDocument, range: SemanticRange): string {
  const anchor = clampSemanticAnchor(document, range.anchor);
  const focus = clampSemanticAnchor(document, range.focus, "end");
  if (!anchor || !focus) return "";
  const [start, end] =
    compareSemanticAnchors(document, anchor, focus) <= 0 ? [anchor, focus] : [focus, anchor];
  const startIndex = indexOfBlock(document, start.blockId);
  const endIndex = indexOfBlock(document, end.blockId);
  if (startIndex === endIndex) {
    return document.blocks[startIndex]!.text.slice(start.offset, end.offset);
  }

  const parts = [document.blocks[startIndex]!.text.slice(start.offset)];
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    parts.push(document.blocks[index]!.text);
  }
  parts.push(document.blocks[endIndex]!.text.slice(0, end.offset));
  return parts.join(SEMANTIC_BLOCK_SEPARATOR);
}

export function moveSemanticAnchor(
  document: SemanticDocument,
  requested: SemanticAnchor,
  movement: SemanticMovement,
): SemanticAnchor | undefined {
  const anchor = clampSemanticAnchor(document, requested);
  if (!anchor) return undefined;
  const index = indexOfBlock(document, anchor.blockId);
  const block = document.blocks[index]!;

  switch (movement) {
    case "left":
      return moveCharacter(document, index, anchor.offset, -1);
    case "right":
      return moveCharacter(document, index, anchor.offset, 1);
    case "word-left":
      return moveWord(document, index, anchor.offset, -1);
    case "word-right":
      return moveWord(document, index, anchor.offset, 1);
    case "line-start":
      return { blockId: block.id, offset: lineBounds(block.text, anchor.offset).start };
    case "line-end":
      return { blockId: block.id, offset: lineBounds(block.text, anchor.offset).end };
    case "up":
      return moveLine(document, index, anchor.offset, -1);
    case "down":
      return moveLine(document, index, anchor.offset, 1);
  }
}

/** SEL-005: double-click selects a whole URL/path as one unit, else a word. */
export function semanticWordRange(
  document: SemanticDocument,
  requested: SemanticAnchor,
): SemanticRange | undefined {
  const anchor = clampSemanticAnchor(document, requested);
  if (!anchor) return undefined;
  const block = document.blocks[indexOfBlock(document, anchor.blockId)]!;
  if (block.text.length === 0) return { anchor, focus: anchor };

  const link = detectLinks(block.text).find(
    (span) => anchor.offset >= span.start && anchor.offset < span.end,
  );
  if (link) {
    return {
      anchor: { blockId: block.id, offset: link.start },
      focus: { blockId: block.id, offset: link.end },
    };
  }

  const character = Math.min(anchor.offset, block.text.length - 1);
  if (!isWordCharacter(block.text[character]!)) return { anchor, focus: anchor };

  let start = character;
  let end = character + 1;
  while (start > 0 && isWordCharacter(block.text[start - 1]!)) start -= 1;
  while (end < block.text.length && isWordCharacter(block.text[end]!)) end += 1;
  return {
    anchor: { blockId: block.id, offset: start },
    focus: { blockId: block.id, offset: end },
  };
}

export function semanticLineRange(
  document: SemanticDocument,
  requested: SemanticAnchor,
): SemanticRange | undefined {
  const anchor = clampSemanticAnchor(document, requested);
  if (!anchor) return undefined;
  const block = document.blocks[indexOfBlock(document, anchor.blockId)]!;
  const bounds = lineBounds(block.text, anchor.offset);
  const newline = block.text[bounds.end] === "\n" ? 1 : 0;
  return {
    anchor: { blockId: block.id, offset: bounds.start },
    focus: { blockId: block.id, offset: bounds.end + newline },
  };
}

function indexOfBlock(document: SemanticDocument, id: string): number {
  return document.blocks.findIndex((block) => block.id === id);
}

function moveCharacter(
  document: SemanticDocument,
  index: number,
  offset: number,
  direction: -1 | 1,
): SemanticAnchor {
  const block = document.blocks[index]!;
  if (direction < 0) {
    if (offset > 0) return { blockId: block.id, offset: offset - 1 };
    const previous = document.blocks[index - 1];
    return previous ? { blockId: previous.id, offset: previous.text.length } : { blockId: block.id, offset };
  }
  if (offset < block.text.length) return { blockId: block.id, offset: offset + 1 };
  const next = document.blocks[index + 1];
  return next ? { blockId: next.id, offset: 0 } : { blockId: block.id, offset };
}

function moveWord(
  document: SemanticDocument,
  index: number,
  offset: number,
  direction: -1 | 1,
): SemanticAnchor {
  const block = document.blocks[index]!;
  let cursor = offset;
  if (direction < 0) {
    while (cursor > 0 && !isWordCharacter(block.text[cursor - 1]!)) cursor -= 1;
    while (cursor > 0 && isWordCharacter(block.text[cursor - 1]!)) cursor -= 1;
    if (cursor > 0 || index === 0) return { blockId: block.id, offset: cursor };
    return moveWord(document, index - 1, document.blocks[index - 1]!.text.length, direction);
  }

  while (cursor < block.text.length && !isWordCharacter(block.text[cursor]!)) cursor += 1;
  while (cursor < block.text.length && isWordCharacter(block.text[cursor]!)) cursor += 1;
  if (cursor < block.text.length || index === document.blocks.length - 1) {
    return { blockId: block.id, offset: cursor };
  }
  return moveWord(document, index + 1, 0, direction);
}

function moveLine(
  document: SemanticDocument,
  index: number,
  offset: number,
  direction: -1 | 1,
): SemanticAnchor {
  const block = document.blocks[index]!;
  const current = lineBounds(block.text, offset);
  const column = offset - current.start;
  if (direction < 0) {
    if (current.start > 0) {
      const previousEnd = current.start - 1;
      const previous = lineBounds(block.text, previousEnd);
      return { blockId: block.id, offset: Math.min(previous.start + column, previous.end) };
    }
    const previousBlock = document.blocks[index - 1];
    if (!previousBlock) return { blockId: block.id, offset };
    const previous = lineBounds(previousBlock.text, previousBlock.text.length);
    return { blockId: previousBlock.id, offset: Math.min(previous.start + column, previous.end) };
  }

  if (current.end < block.text.length) {
    const next = lineBounds(block.text, current.end + 1);
    return { blockId: block.id, offset: Math.min(next.start + column, next.end) };
  }
  const nextBlock = document.blocks[index + 1];
  if (!nextBlock) return { blockId: block.id, offset };
  const next = lineBounds(nextBlock.text, 0);
  return { blockId: nextBlock.id, offset: Math.min(next.start + column, next.end) };
}

function lineBounds(text: string, requestedOffset: number): { start: number; end: number } {
  const offset = Math.max(0, Math.min(requestedOffset, text.length));
  const before = text.lastIndexOf("\n", Math.max(0, offset - 1));
  const start = before < 0 ? 0 : before + 1;
  const next = text.indexOf("\n", offset);
  return { start, end: next < 0 ? text.length : next };
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}
