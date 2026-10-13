
export class PromptHistory {
  private readonly entries: string[] = [];
  private cursor = -1;
  private draft = "";
  private olderCount = 0;
  private loadOlder: (() => Promise<string | undefined>) | undefined;
  private olderExhausted = false;
  private revision = 0;
  private pending = 0;
  private queue: Promise<unknown> = Promise.resolve();

  get generation(): number { return this.revision; }

  setOlderSource(loadOlder: (() => Promise<string | undefined>) | undefined, clearEntries = false): void {
    this.entries.splice(0, clearEntries ? this.entries.length : this.olderCount);
    this.olderCount = 0;
    this.loadOlder = loadOlder;
    this.olderExhausted = false;
    this.reset();
  }

  prevWithSaved(currentValue: string): string | undefined | Promise<string | undefined> {
    if (this.pending === 0 && (!this.loadOlder || this.olderExhausted || (this.entries.length > 0 && this.cursor !== 0))) {
      return this.prev(currentValue);
    }
    const revision = this.revision;
    return this.enqueue(async () => {
      if (revision !== this.revision) return undefined;
      const source = this.loadOlder;
      if (source && !this.olderExhausted && (this.entries.length === 0 || this.cursor === 0)) {
        let older: string | undefined;
        do { older = await source(); }
        while (this.loadOlder === source && older !== undefined && older === this.entries[0]);
        if (this.loadOlder !== source) return undefined;
        if (older !== undefined) {
          this.entries.unshift(older);
          this.olderCount += 1;
          if (this.cursor >= 0) this.cursor += 1;
        } else this.olderExhausted = true;
      }
      return revision === this.revision ? this.prev(currentValue) : undefined;
    });
  }

  nextWithSaved(): string | undefined | Promise<string | undefined> {
    if (this.pending === 0) return this.next();
    const revision = this.revision;
    return this.enqueue(async () => revision === this.revision ? this.next() : undefined);
  }

  private enqueue(operation: () => Promise<string | undefined>): Promise<string | undefined> {
    this.pending += 1;
    const result = this.queue.then(operation, operation).finally(() => { this.pending -= 1; });
    this.queue = result;
    return result;
  }

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
    this.revision += 1;
    this.cursor = -1;
    this.draft = "";
  }

  isBrowsing(): boolean {
    return this.cursor >= 0 || this.pending > 0;
  }
}

export function recallPromptHistory(
  history: PromptHistory,
  direction: "up" | "down",
  currentValue: string,
  onRecall: (text: string) => void,
  onError: () => void,
  onEmpty?: () => void,
): boolean {
  const generation = history.generation;
  const apply = (text: string | undefined): void => {
    if (generation !== history.generation) return;
    if (text === undefined) onEmpty?.();
    else onRecall(text);
  };
  const recalled = direction === "up" ? history.prevWithSaved(currentValue) : history.nextWithSaved();
  if (recalled instanceof Promise) {
    void recalled.then(apply).catch(() => { if (generation === history.generation) onError(); });
    return true;
  }
  apply(recalled);
  return recalled !== undefined;
}
