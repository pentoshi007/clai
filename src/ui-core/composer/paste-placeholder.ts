
const DEFAULT_LINE_THRESHOLD = 8;
const DEFAULT_CHAR_THRESHOLD = 800;

export interface PasteThresholds {
  readonly lines?: number;
  readonly chars?: number;
}

export function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split("\n").length;
}

export function isLargePaste(text: string, thresholds: PasteThresholds = {}): boolean {
  const lineLimit = thresholds.lines ?? DEFAULT_LINE_THRESHOLD;
  const charLimit = thresholds.chars ?? DEFAULT_CHAR_THRESHOLD;
  return countLines(text) > lineLimit || text.length > charLimit;
}

export function pastePreviewLines(text: string, maxLines = 2): string[] {
  const lines = text.split("\n");
  return lines.slice(0, Math.max(1, maxLines)).map((line) => {
    const clipped = line.length > 72 ? `${line.slice(0, 71)}…` : line;
    return clipped.length === 0 ? " " : clipped;
  });
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
    let result = value;
    for (const entry of this.entries.values()) {
      result = result.split(entry.token).join(entry.text);
    }
    return result;
  }

  expandOne(value: string, id: number): string {
    const entry = this.entries.get(id);
    if (!entry) return value;
    return value.split(entry.token).join(entry.text);
  }
}
