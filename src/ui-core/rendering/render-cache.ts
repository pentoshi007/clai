export class RenderCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private retainedWeight = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxWeight: number,
  ) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
    if (!Number.isSafeInteger(maxWeight) || maxWeight < 1) {
      throw new RangeError("maxWeight must be a positive integer");
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get weight(): number {
    return this.retainedWeight;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, valueWeight: number): void {
    if (!Number.isSafeInteger(valueWeight) || valueWeight < 0) {
      throw new RangeError("valueWeight must be a nonnegative integer");
    }
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.retainedWeight -= existing.weight;
    }
    const weight = key.length * 2 + valueWeight + 128;
    if (weight > this.maxWeight) return;
    while (
      this.entries.size >= this.maxEntries ||
      this.retainedWeight + weight > this.maxWeight
    ) {
      const oldest = this.entries.entries().next().value;
      if (!oldest) break;
      this.entries.delete(oldest[0]);
      this.retainedWeight -= oldest[1].weight;
    }
    this.entries.set(key, { value, weight });
    this.retainedWeight += weight;
  }
}
