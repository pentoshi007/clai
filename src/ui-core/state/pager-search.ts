
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

export function nextPagerMatch(matches: readonly PagerMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current + 1 + matches.length) % matches.length;
}

export function prevPagerMatch(matches: readonly PagerMatch[], current: number): number {
  if (matches.length === 0) return -1;
  return (current - 1 + matches.length) % matches.length;
}

export interface PagerLineSegment {
  readonly text: string;
  readonly kind: "plain" | "match" | "active";
}

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
    if (start < cursor) continue;
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

export interface OverlaidPagerPiece<T> {
  readonly source: T;
  readonly text: string;
  readonly kind: PagerLineSegment["kind"];
}

export function overlayPagerSegments<T extends { readonly text: string }>(
  pieces: readonly T[],
  segments: readonly PagerLineSegment[],
): OverlaidPagerPiece<T>[] {
  const out: OverlaidPagerPiece<T>[] = [];
  let segment = 0;
  let segmentLeft = segments[0]?.text.length ?? 0;
  for (const source of pieces) {
    let text = source.text;
    while (text.length > 0) {
      while (segmentLeft === 0 && segment < segments.length - 1) {
        segment += 1;
        segmentLeft = segments[segment]!.text.length;
      }
      const kind = segments[segment]?.kind ?? "plain";
      const take = segmentLeft > 0 ? Math.min(segmentLeft, text.length) : text.length;
      out.push({ source, text: text.slice(0, take), kind });
      text = text.slice(take);
      segmentLeft = Math.max(0, segmentLeft - take);
    }
  }
  return out;
}
