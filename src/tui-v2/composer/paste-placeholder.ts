/**
 * Large-paste placeholders (INPUT-003, V2-042).
 *
 * A large paste is replaced in the visible buffer by a single short token so
 * it stays scannable and cheap to edit around; the real text is kept in a
 * registry and swapped back in at submit time. Because the placeholder is
 * inserted with one `insertText` call, it is one undo step — undoing it
 * removes the whole paste, not one character at a time.
 */

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

export interface PastePlaceholderEntry {
  readonly id: number;
  readonly token: string;
  readonly text: string;
  readonly lines: number;
  readonly chars: number;
}

/**
 * Holds full pasted text keyed by an incrementing id and renders the token
 * shown in the composer buffer in its place.
 */
export class PasteRegistry {
  private readonly entries = new Map<number, PastePlaceholderEntry>();
  private nextId = 1;

  register(text: string): PastePlaceholderEntry {
    const id = this.nextId++;
    const lines = countLines(text);
    const entry: PastePlaceholderEntry = {
      id,
      token: `[Pasted text #${id} +${lines} lines]`,
      text,
      lines,
      chars: text.length,
    };
    this.entries.set(id, entry);
    return entry;
  }

  resolve(id: number): PastePlaceholderEntry | undefined {
    return this.entries.get(id);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Replace every known placeholder token in `value` with its full text. */
  expand(value: string): string {
    let result = value;
    for (const entry of this.entries.values()) {
      result = result.split(entry.token).join(entry.text);
    }
    return result;
  }
}
