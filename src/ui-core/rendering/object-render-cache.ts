interface Entry<V> {
  readonly signature: string;
  readonly value: V;
  readonly weight: number;
}

export class ObjectRenderCache<K extends object, V> {
  private readonly entries = new Map<K, Entry<V>>();
  private retainedWeight = 0;

  constructor(private readonly maxWeight: number) {
    if (!Number.isSafeInteger(maxWeight) || maxWeight < 1) {
      throw new RangeError("maxWeight must be a positive integer");
    }
  }

  get weight(): number {
    return this.retainedWeight;
  }

  get(key: K, signature: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.signature !== signature) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, signature: string, value: V, weight: number): V {
    this.remove(key);
    const size = Math.max(0, Math.ceil(weight)) + 128;
    if (size > this.maxWeight) return value;
    while (this.retainedWeight + size > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.remove(oldest.value);
    }
    this.entries.set(key, { signature, value, weight: size });
    this.retainedWeight += size;
    return value;
  }

  resolve(key: K, signature: string, build: () => V, weigh: (value: V) => number): V {
    const hit = this.get(key, signature);
    if (hit !== undefined) return hit;
    const value = build();
    return this.set(key, signature, value, weigh(value));
  }

  private remove(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.retainedWeight -= entry.weight;
  }
}

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

export function objectIdentity(value: object | undefined): number {
  if (!value) return 0;
  let id = identities.get(value);
  if (id === undefined) {
    id = nextIdentity;
    nextIdentity += 1;
    identities.set(value, id);
  }
  return id;
}
