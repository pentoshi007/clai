
const ANSI_ESCAPE_RE =
  /(?:\u{1b}\]|\x9d)[^\x07\u{1b}\x9c]*(?:\x07|\u{1b}\\|\x9c)?|(?:\u{1b}[PX^_]|[\x90\x98\x9e\x9f])[^\u{1b}\x9c]*(?:\u{1b}\\|\x9c)?|(?:\u{1b}\[|\x9b)[0-?]*[ -/]*[@-~]?|\u{1b}(?:[ -/]+[0-~]|[@-Z\\-_a-z0-9=><~])/gu;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/g;
const DISPLAY_CONTROLS_RE = new RegExp(`${ANSI_ESCAPE_RE.source}|${CONTROL_CHARS_RE.source}`, "gu");

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

export function stripControlChars(text: string): string {
  return text.replace(CONTROL_CHARS_RE, "");
}

export function sanitizeDisplayText(text: string): string {
  return text.replace(DISPLAY_CONTROLS_RE, "");
}

export function sanitizeDisplayTextChunks<T extends { text: string }>(chunks: readonly T[]): T[] {
  const text = chunks.map((chunk) => chunk.text).join("");
  const removed = Array.from(text.matchAll(DISPLAY_CONTROLS_RE), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  if (removed.length === 0) return chunks.slice();
  let offset = 0;
  let removalIndex = 0;
  return chunks.map((chunk) => {
    const start = offset;
    const end = start + chunk.text.length;
    offset = end;
    let cursor = start;
    let clean = "";
    while (removalIndex < removed.length) {
      const removal = removed[removalIndex]!;
      if (removal.start >= end) break;
      clean += text.slice(cursor, Math.max(cursor, removal.start));
      cursor = Math.min(end, removal.end);
      if (removal.end > end) break;
      removalIndex += 1;
    }
    clean += text.slice(cursor, end);
    return clean === chunk.text ? chunk : { ...chunk, text: clean };
  });
}
