/** Pure line-oriented search for the pager (PICK-003, V2-074). */

export interface PagerMatch {
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export function findPagerMatches(lines: readonly string[], query: string): PagerMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: PagerMatch[] = [];
  for (let line = 0; line < lines.length; line += 1) {
    const haystack = lines[line]!.toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      matches.push({ line, column: at, length: needle.length });
      from = at + needle.length;
    }
  }
  return matches;
}

/** Wraps forward; returns -1 when there are no matches to navigate. */
export function nextPagerMatch(matches: readonly PagerMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current + 1 + matches.length) % matches.length;
}

/** Wraps backward; returns -1 when there are no matches to navigate. */
export function prevPagerMatch(matches: readonly PagerMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current - 1 + matches.length) % matches.length;
}

/** One painted run inside a pager body line. */
export interface PagerLineSegment {
  readonly text: string;
  /** Inactive hit vs the currently selected hit (Enter/n/N). */
  readonly kind: "plain" | "match" | "active";
}

/**
 * Split a body line into plain/match/active segments for reverse-video paint.
 * Overlapping ranges are not expected (non-overlapping indexOf walk).
 */
export function segmentPagerLine(
  line: string,
  lineIndex: number,
  matches: readonly PagerMatch[],
  activeMatchIndex: number,
): PagerLineSegment[] {
  const onLine: Array<{ column: number; length: number; active: boolean }> = [];
  for (let i = 0; i < matches.length; i += 1) {
    const m = matches[i]!;
    if (m.line !== lineIndex) continue;
    onLine.push({
      column: m.column,
      length: m.length,
      active: i === activeMatchIndex,
    });
  }
  if (onLine.length === 0) {
    return [{ text: line.length > 0 ? line : " ", kind: "plain" }];
  }

  onLine.sort((a, b) => a.column - b.column);
  const segments: PagerLineSegment[] = [];
  let cursor = 0;
  for (const hit of onLine) {
    const start = Math.max(0, Math.min(line.length, hit.column));
    const end = Math.max(start, Math.min(line.length, hit.column + hit.length));
    if (start < cursor) continue; // skip overlap
    if (start > cursor) {
      segments.push({ text: line.slice(cursor, start), kind: "plain" });
    }
    if (end > start) {
      segments.push({
        text: line.slice(start, end),
        kind: hit.active ? "active" : "match",
      });
    }
    cursor = end;
  }
  if (cursor < line.length) {
    segments.push({ text: line.slice(cursor), kind: "plain" });
  }
  if (segments.length === 0) {
    return [{ text: line.length > 0 ? line : " ", kind: "plain" }];
  }
  return segments;
}
