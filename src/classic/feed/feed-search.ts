import { compileSearchQuery, searchRanges, type TextRange } from "../../ui-core/state/text-search.js";
import type { PagerLineSegment } from "../../ui-core/state/pager-search.js";
import { stripAnsi } from "../render/measure.js";
import type { InkTheme } from "../render/ink-theme.js";
import { sealStyle } from "../render/ansi-text.js";
import { paintSearchMatches } from "../panels/pager-search-paint.js";
import { INTRO_ITEM_ID, type FeedBlock } from "./feed-blocks.js";
import { offsetForTranscriptAnchor, totalTranscriptRows } from "./transcript-window.js";

export interface FeedMatchPosition {
  readonly blockIndex: number;
  readonly lineIndex: number;
  readonly start: number;
}

export interface FeedMatchIdentity {
  readonly itemId: string;
  readonly occurrence: number;
}

export interface FeedMatch extends FeedMatchPosition, FeedMatchIdentity {
  readonly blockKey: string;
  readonly end: number;
}

interface LineRanges {
  readonly lineIndex: number;
  readonly ranges: readonly TextRange[];
}

const blockRanges = new WeakMap<FeedBlock, { readonly query: string; readonly lines: readonly LineRanges[] }>();
let lastSearch: { readonly blocks: readonly FeedBlock[]; readonly query: string; readonly matches: readonly FeedMatch[] } | undefined;

function rangesFor(block: FeedBlock, query: string, pattern: RegExp): readonly LineRanges[] {
  const cached = blockRanges.get(block);
  if (cached?.query === query) return cached.lines;
  const lines: LineRanges[] = [];
  block.lines.forEach((line, lineIndex) => {
    const ranges = searchRanges(stripAnsi(line), pattern);
    if (ranges.length > 0) lines.push({ lineIndex, ranges });
  });
  blockRanges.set(block, { query, lines });
  return lines;
}

export function findFeedMatches(blocks: readonly FeedBlock[], query: string): readonly FeedMatch[] {
  if (lastSearch?.blocks === blocks && lastSearch.query === query) return lastSearch.matches;
  const pattern = compileSearchQuery(query);
  const matches: FeedMatch[] = [];
  if (pattern) {
    const occurrences = new Map<string, number>();
    blocks.forEach((block, blockIndex) => {
      if (block.itemId === INTRO_ITEM_ID) return;
      for (const { lineIndex, ranges } of rangesFor(block, query, pattern)) {
        for (const range of ranges) {
          const occurrence = occurrences.get(block.itemId) ?? 0;
          occurrences.set(block.itemId, occurrence + 1);
          matches.push({
            blockKey: block.key,
            itemId: block.itemId,
            occurrence,
            blockIndex,
            lineIndex,
            start: range.start,
            end: range.end,
          });
        }
      }
    });
  }
  lastSearch = { blocks, query, matches };
  return matches;
}

export function feedMatchIndex(matches: readonly FeedMatch[], identity: FeedMatchIdentity | undefined): number {
  if (!identity) return -1;
  return matches.findIndex((match) => match.itemId === identity.itemId && match.occurrence === identity.occurrence);
}

export function nearestFeedMatch(matches: readonly FeedMatch[], position: FeedMatchPosition): number {
  if (matches.length === 0) return -1;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    if (match.blockIndex < position.blockIndex) return index;
    if (match.blockIndex > position.blockIndex) continue;
    if (match.lineIndex < position.lineIndex) return index;
    if (match.lineIndex === position.lineIndex && match.start <= position.start) return index;
  }
  return 0;
}

export function offsetForFeedMatch(
  blocks: readonly FeedBlock[],
  budget: number,
  match: Pick<FeedMatch, "blockKey" | "lineIndex">,
): number | undefined {
  const rows = Math.max(1, Math.floor(budget));
  const top = offsetForTranscriptAnchor(blocks, rows, { blockKey: match.blockKey, lineIndex: match.lineIndex });
  if (top === undefined) return undefined;
  const maxOffset = Math.max(0, totalTranscriptRows(blocks) - rows);
  return Math.max(0, Math.min(maxOffset, top + Math.floor(rows / 2)));
}

export interface FeedHighlight {
  readonly rows: ReadonlyMap<string, readonly TextRange[]>;
  readonly activeRow: string | undefined;
  readonly activeStart: number;
}

export function feedRowKey(blockKey: string, lineIndex: number): string {
  return `${blockKey}:${lineIndex}`;
}

export function feedHighlight(matches: readonly FeedMatch[], activeIndex: number): FeedHighlight {
  const rows = new Map<string, TextRange[]>();
  for (const match of matches) {
    const key = feedRowKey(match.blockKey, match.lineIndex);
    const ranges = rows.get(key);
    const range = { start: match.start, end: match.end };
    if (ranges) ranges.push(range);
    else rows.set(key, [range]);
  }
  const active = matches[activeIndex];
  return {
    rows,
    activeRow: active ? feedRowKey(active.blockKey, active.lineIndex) : undefined,
    activeStart: active?.start ?? -1,
  };
}

function rowSegments(plain: string, ranges: readonly TextRange[], activeStart: number): PagerLineSegment[] {
  const segments: PagerLineSegment[] = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(plain.length, range.start));
    const end = Math.max(start, Math.min(plain.length, range.end));
    if (start > cursor) segments.push({ text: plain.slice(cursor, start), kind: "plain" });
    if (end > start) segments.push({ text: plain.slice(start, end), kind: range.start === activeStart ? "active" : "match" });
    cursor = end;
  }
  if (cursor < plain.length) segments.push({ text: plain.slice(cursor), kind: "plain" });
  return segments;
}

export function paintFeedRow(ink: InkTheme, line: string, key: string, highlight: FeedHighlight | undefined): string {
  const ranges = highlight?.rows.get(key);
  if (!highlight || !ranges) return line;
  const activeStart = highlight.activeRow === key ? highlight.activeStart : -1;
  const segments = rowSegments(stripAnsi(line), ranges, activeStart);
  return segments.length === 0 ? sealStyle(line) : paintSearchMatches(ink, line, segments);
}
