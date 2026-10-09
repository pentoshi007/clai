
const DEFAULT_LINE_THRESHOLD = 8;
const DEFAULT_CHAR_THRESHOLD = 800;

export interface PasteThresholds {
  readonly lines?: number;
  readonly chars?: number;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
    lines += 1;
  }
  return lines;
}

export function isLargePaste(text: string, thresholds: PasteThresholds = {}): boolean {
  const lineLimit = thresholds.lines ?? DEFAULT_LINE_THRESHOLD;
  const charLimit = thresholds.chars ?? DEFAULT_CHAR_THRESHOLD;
  return text.length > charLimit || countLines(text) > lineLimit;
}

export function pastePreviewLines(text: string, maxLines = 2): string[] {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < Math.max(1, maxLines)) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    const line = end - start > 72
      ? `${text.slice(start, start + 71)}…`
      : text.slice(start, end);
    lines.push(line || " ");
    if (newline < 0) break;
    start = newline + 1;
  }
  return lines;
}

export function pasteChipLabel(lines: number, chars: number): string {
  if (lines > 1) return `${lines} lines pasted`;
  if (chars > 0) return `${chars} chars pasted`;
  return "pasted";
}

export interface PastePlaceholderEntry {
  readonly id: number;
  readonly token: string;
  readonly text: string;
  readonly lines: number;
  readonly chars: number;
  readonly label: string;
}

export interface PastePlaceholderRange {
  readonly start: number;
  readonly end: number;
  readonly entry: PastePlaceholderEntry;
}

export function pastePlaceholderRanges(
  text: string,
  entries: readonly PastePlaceholderEntry[],
): PastePlaceholderRange[] {
  return entries.flatMap((entry) => {
    const ranges = [];
    for (
      let start = text.indexOf(entry.token);
      start >= 0;
      start = text.indexOf(entry.token, start + entry.token.length)
    ) {
      ranges.push({ start, end: start + entry.token.length, entry });
    }
    return ranges;
  });
}

export function samePastePlaceholderEntries(
  a: readonly PastePlaceholderEntry[],
  b: readonly PastePlaceholderEntry[],
): boolean {
  return a.length === b.length && a.every((item, index) => item.id === b[index]?.id);
}

export class PasteRegistry {
  private readonly entries = new Map<number, PastePlaceholderEntry>();
  private nextId = 1;

  register(text: string): PastePlaceholderEntry {
    const id = this.nextId++;
    const lines = countLines(text);
    const chars = text.length;
    const entry: PastePlaceholderEntry = {
      id,
      token: `[${pasteChipLabel(lines, chars)} #${id}]`,
      text,
      lines,
      chars,
      label: pasteChipLabel(lines, chars),
    };
    this.entries.set(id, entry);
    return entry;
  }

  resolve(id: number): PastePlaceholderEntry | undefined {
    return this.entries.get(id);
  }

  activeIn(value: string): PastePlaceholderEntry[] {
    const out: PastePlaceholderEntry[] = [];
    for (const entry of this.entries.values()) {
      if (value.includes(entry.token)) out.push(entry);
    }
    return out;
  }

  clear(): void {
    this.entries.clear();
  }

  expand(value: string): string {
    return value.replace(
      /\[(?:\d+ (?:lines|chars) pasted|pasted) #(\d+)\]/g,
      (token, id: string) => {
        const entry = this.entries.get(Number(id));
        return entry?.token === token ? entry.text : token;
      },
    );
  }

  expandOne(value: string, id: number): string {
    const entry = this.entries.get(id);
    if (!entry) return value;
    return value.split(entry.token).join(entry.text);
  }

  expandNearest(
    value: string,
    cursor: number,
    id?: number,
  ): { readonly text: string; readonly cursor: number } | undefined {
    const position = Math.max(0, Math.min(value.length, cursor));
    let nearest: PastePlaceholderRange | undefined;
    let distance = Infinity;
    for (const range of pastePlaceholderRanges(value, this.activeIn(value))) {
      if (id !== undefined && range.entry.id !== id) continue;
      const nextDistance = Math.max(range.start - position, position - range.end, 0);
      if (
        !nearest ||
        nextDistance < distance ||
        (nextDistance === distance && range.start < nearest.start)
      ) {
        nearest = range;
        distance = nextDistance;
      }
    }
    if (!nearest) return undefined;
    const { start, end, entry } = nearest;
    return {
      text: value.slice(0, start) + entry.text + value.slice(end),
      cursor: position < start
        ? position
        : Math.max(start + entry.text.length, position + entry.text.length - (end - start)),
    };
  }
}
