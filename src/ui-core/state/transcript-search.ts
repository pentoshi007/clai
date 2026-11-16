import {
  itemSearchText,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript-types.js";
import { compileSearchQuery, searchRanges, stepMatchIndex, type TextRange } from "./text-search.js";

export interface TranscriptMatch {
  readonly itemId: string;
  readonly itemIndex: number;
  readonly occurrence: number;
  readonly start: number;
  readonly end: number;
}

export type TranscriptSearchFilter = (item: TranscriptItem) => boolean;

const itemRanges = new WeakMap<TranscriptItem, { readonly pattern: RegExp; readonly ranges: readonly TextRange[] }>();

function rangesFor(item: TranscriptItem, pattern: RegExp): readonly TextRange[] {
  const cached = itemRanges.get(item);
  if (cached?.pattern === pattern) return cached.ranges;
  const ranges = searchRanges(itemSearchText(item), pattern);
  itemRanges.set(item, { pattern, ranges });
  return ranges;
}

export function findMatches(
  state: TranscriptState,
  query: string,
  include?: TranscriptSearchFilter,
): TranscriptMatch[] {
  const pattern = compileSearchQuery(query);
  if (!pattern) return [];
  const matches: TranscriptMatch[] = [];
  for (let itemIndex = 0; itemIndex < state.order.length; itemIndex += 1) {
    const item = state.byId.get(state.order[itemIndex]!);
    if (!item || (include && !include(item))) continue;
    const ranges = rangesFor(item, pattern);
    for (let occurrence = 0; occurrence < ranges.length; occurrence += 1) {
      const range = ranges[occurrence]!;
      matches.push({ itemId: item.id, itemIndex, occurrence, start: range.start, end: range.end });
    }
  }
  return matches;
}

export function nextMatchIndex(matches: readonly TranscriptMatch[], current: number): number {
  return stepMatchIndex(matches.length, current, 1);
}

export function prevMatchIndex(matches: readonly TranscriptMatch[], current: number): number {
  return stepMatchIndex(matches.length, current, -1);
}

export interface TranscriptMatchPosition {
  readonly itemIndex: number;
  readonly start: number;
}

export function nearestMatchAtOrBefore(
  matches: readonly TranscriptMatch[],
  position: TranscriptMatchPosition,
): number {
  if (matches.length === 0) return -1;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    if (match.itemIndex < position.itemIndex) return index;
    if (match.itemIndex === position.itemIndex && match.start <= position.start) return index;
  }
  return 0;
}

export function matchesByItem(
  matches: readonly TranscriptMatch[],
): ReadonlyMap<string, readonly TranscriptMatch[]> {
  const grouped = new Map<string, TranscriptMatch[]>();
  for (const match of matches) {
    const group = grouped.get(match.itemId);
    if (group) group.push(match);
    else grouped.set(match.itemId, [match]);
  }
  return grouped;
}
