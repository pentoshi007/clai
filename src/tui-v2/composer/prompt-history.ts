/**
 * Prompt recall history for the composer (INPUT-006, V2-043).
 *
 * Mirrors the classic REPL's history/draft semantics (`src/tui/App.tsx`) as a
 * standalone, renderer-independent class: consecutive duplicates are not
 * re-recorded, an in-progress draft is preserved while browsing history, and
 * moving past the newest entry restores that draft rather than blanking it.
 */

export class PromptHistory {
  private readonly entries: string[] = [];
  private cursor = -1;
  private draft = "";

  push(text: string): void {
    if (this.entries[this.entries.length - 1] === text) return;
    this.entries.push(text);
  }

  get size(): number {
    return this.entries.length;
  }

  /** Move to the previous (older) entry, saving `currentValue` as the draft. */
  prev(currentValue: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor < 0) this.draft = currentValue;
    this.cursor = this.cursor < 0 ? this.entries.length - 1 : Math.max(0, this.cursor - 1);
    return this.entries[this.cursor];
  }

  /** Move to the next (newer) entry, or restore the saved draft past the end. */
  next(): string | undefined {
    if (this.cursor < 0) return undefined;
    const nextIndex = this.cursor + 1;
    if (nextIndex >= this.entries.length) {
      this.cursor = -1;
      return this.draft;
    }
    this.cursor = nextIndex;
    return this.entries[this.cursor];
  }

  /** Reset browsing state, e.g. after a submit or an explicit edit. */
  reset(): void {
    this.cursor = -1;
    this.draft = "";
  }

  isBrowsing(): boolean {
    return this.cursor >= 0;
  }
}
