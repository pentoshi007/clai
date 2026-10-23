function protectedSpanEnd(text: string, start: number): number {
  if (text[start] === "\\") return Math.min(text.length, start + 2);
  if (text[start] === "`") {
    let end = start + 1;
    while (text[end] === "`") end += 1;
    const marker = text.slice(start, end);
    const close = text.indexOf(marker, end);
    return close < 0 ? end : close + marker.length;
  }
  if (text[start] !== "[") return start;
  const labelEnd = text.indexOf("]", start + 1);
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return start;
  const linkEnd = text.indexOf(")", labelEnd + 2);
  return linkEnd < 0 ? start : linkEnd + 1;
}

function boldMarkerAt(text: string, start: number): string | undefined {
  if (text.startsWith("***", start)) return "***";
  if (text.startsWith("**", start)) return "**";
  if (text.startsWith("__", start)) return "__";
  return undefined;
}

function findClosingMarker(text: string, start: number, marker: string): number {
  let index = start;
  while (index < text.length) {
    const protectedEnd = protectedSpanEnd(text, index);
    if (protectedEnd > index) {
      index = protectedEnd;
      continue;
    }
    if (text.startsWith(marker, index)) return index;
    index += 1;
  }
  return -1;
}

export function splitBoldLines(text: string): string[] {
  if (!text.includes("**") && !text.includes("__")) return [text];
  const rows: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const protectedEnd = protectedSpanEnd(text, index);
    if (protectedEnd > index) {
      index = protectedEnd;
      continue;
    }
    const marker = boldMarkerAt(text, index);
    if (!marker) {
      index += 1;
      continue;
    }
    const close = findClosingMarker(text, index + marker.length, marker);
    if (close <= index + marker.length) {
      index += marker.length;
      continue;
    }
    const before = text.slice(start, index).trim();
    if (before) rows.push(before);
    rows.push(text.slice(index, close + marker.length));
    index = close + marker.length;
    start = index;
  }
  if (rows.length === 0) return [text];
  const after = text.slice(start).trim();
  if (after) rows.push(after);
  return rows;
}
