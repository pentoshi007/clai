
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

  prev(currentValue: string): string | undefined {
    if (this.entries.length === 0) return undefined;
    if (this.cursor < 0) this.draft = currentValue;
    this.cursor = this.cursor < 0 ? this.entries.length - 1 : Math.max(0, this.cursor - 1);
    return this.entries[this.cursor];
  }

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

  reset(): void {
    this.cursor = -1;
    this.draft = "";
  }

  isBrowsing(): boolean {
    return this.cursor >= 0;
  }
}
