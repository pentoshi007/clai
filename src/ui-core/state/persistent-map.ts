const REMOVED: unique symbol = Symbol("removed");

type Slot<V> = V | typeof REMOVED;

const MIN_OVERLAY_ENTRIES = 32;

export class PersistentMap<K, V> implements ReadonlyMap<K, V> {
  private constructor(
    private readonly base: ReadonlyMap<K, V>,
    private readonly overlay: ReadonlyMap<K, Slot<V>>,
    readonly size: number,
  ) {}

  static from<K, V>(source: ReadonlyMap<K, V>): PersistentMap<K, V> {
    return source instanceof PersistentMap
      ? (source as PersistentMap<K, V>)
      : new PersistentMap<K, V>(source, new Map(), source.size);
  }

  get(key: K): V | undefined {
    if (this.overlay.has(key)) {
      const slot = this.overlay.get(key)!;
      return slot === REMOVED ? undefined : slot;
    }
    return this.base.get(key);
  }

  has(key: K): boolean {
    if (this.overlay.has(key)) return this.overlay.get(key) !== REMOVED;
    return this.base.has(key);
  }

  set(key: K, value: V): PersistentMap<K, V> {
    if (this.overlay.get(key) === REMOVED) return this.materialize().set(key, value);
    const size = this.has(key) ? this.size : this.size + 1;
    const overlay = new Map(this.overlay);
    overlay.set(key, value);
    return new PersistentMap(this.base, overlay, size).settle();
  }

  delete(key: K): PersistentMap<K, V> {
    if (!this.has(key)) return this;
    const overlay = new Map(this.overlay);
    if (this.base.has(key)) overlay.set(key, REMOVED);
    else overlay.delete(key);
    return new PersistentMap(this.base, overlay, this.size - 1).settle();
  }

  *entries(): MapIterator<[K, V]> {
    for (const [key, value] of this.base) {
      if (!this.overlay.has(key)) {
        yield [key, value];
        continue;
      }
      const slot = this.overlay.get(key)!;
      if (slot !== REMOVED) yield [key, slot];
    }
    for (const [key, slot] of this.overlay) {
      if (slot !== REMOVED && !this.base.has(key)) yield [key, slot];
    }
  }

  *keys(): MapIterator<K> {
    for (const [key] of this.entries()) yield key;
  }

  *values(): MapIterator<V> {
    for (const [, value] of this.entries()) yield value;
  }

  forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.entries()) callback.call(thisArg, value, key, this);
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "PersistentMap";
  }

  private settle(): PersistentMap<K, V> {
    const limit = Math.max(MIN_OVERLAY_ENTRIES, Math.sqrt(this.base.size));
    return this.overlay.size > limit ? this.materialize() : this;
  }

  private materialize(): PersistentMap<K, V> {
    return new PersistentMap<K, V>(new Map(this.entries()), new Map(), this.size);
  }
}
