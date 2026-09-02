
import { itemSearchText, transcriptItems, type TranscriptState } from "./transcript-types.js";

export interface TranscriptMatch {
  readonly itemId: string;
  readonly start: number;
  readonly end: number;
}

export function findMatches(state: TranscriptState, query: string): TranscriptMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: TranscriptMatch[] = [];
  for (const item of transcriptItems(state)) {
    const haystack = itemSearchText(item).toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ itemId: item.id, start: at, end: at + needle.length });
      from = at + needle.length;
    }
  }
  return matches;
}

export function nextMatchIndex(matches: readonly TranscriptMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current + 1 + matches.length) % matches.length;
}

export function prevMatchIndex(matches: readonly TranscriptMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current - 1 + matches.length) % matches.length;
}
