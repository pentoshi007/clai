export function isEscapedAt(text: string, index: number): boolean {
  let start = index;
  while (start > 0 && text[start - 1] === "\\") start -= 1;
  return (index - start) % 2 === 1;
}

export function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === "`") end += 1;
  return end;
}

export function matchCodeSpan(text: string, start: number, openEnd: number): {
  readonly content: string;
  readonly end: number;
} | undefined {
  const length = openEnd - start;
  let close = text.indexOf("`", openEnd);
  while (close !== -1) {
    const end = backtickRunEnd(text, close);
    if (end - close === length) return { content: text.slice(openEnd, close), end };
    close = text.indexOf("`", end);
  }
  return undefined;
}

export function mapOutsideCodeSpans(text: string, map: (prose: string) => string): string {
  let start = text.indexOf("`");
  if (start === -1) return map(text);

  let out = "";
  let cursor = 0;
  while (start !== -1) {
    const openEnd = backtickRunEnd(text, start);
    if (isEscapedAt(text, start)) start += 1;
    const span = start < openEnd ? matchCodeSpan(text, start, openEnd) : undefined;
    if (span) {
      out += map(text.slice(cursor, start)) + text.slice(start, span.end);
      cursor = span.end;
    }
    start = text.indexOf("`", span?.end ?? openEnd);
  }
  return out + map(text.slice(cursor));
}
