interface Entry<K extends object, V> {
  readonly signature: string;
  readonly value: V;
  readonly key: WeakRef<K>;
  readonly weight: number;
}

export class ObjectRenderCache<K extends object, V> {
  private entries = new WeakMap<K, Entry<K, V>>();
  private readonly recency = new Map<WeakRef<K>, number>();
  private retainedWeight = 0;

  constructor(private readonly maxWeight: number) {
    if (!Number.isSafeInteger(maxWeight) || maxWeight < 1) {
      throw new RangeError("maxWeight must be a positive integer");
    }
  }

  get weight(): number {
    return this.retainedWeight;
  }

  clear(): void {
    this.entries = new WeakMap();
    this.recency.clear();
    this.retainedWeight = 0;
  }

  get(key: K, signature: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry || entry.signature !== signature) return undefined;
    this.recency.delete(entry.key);
    this.recency.set(entry.key, entry.weight);
    return entry.value;
  }

  set(key: K, signature: string, value: V, weight: number): V {
    this.remove(key);
    const size = Math.max(0, Math.ceil(weight)) + 128;
    if (size > this.maxWeight) return value;
    while (this.retainedWeight + size > this.maxWeight) {
      const [ref, cost] = this.recency.entries().next().value!;
      const oldest = ref.deref();
      if (oldest) this.entries.delete(oldest);
      this.recency.delete(ref);
      this.retainedWeight -= cost;
    }
    const ref = new WeakRef(key);
    this.entries.set(key, { signature, value, weight: size, key: ref });
    this.recency.set(ref, size);
    this.retainedWeight += size;
    return value;
  }

  resolve(key: K, signature: string, build: () => V, weigh: (value: V) => number): V {
    const hit = this.get(key, signature);
    if (hit !== undefined) return hit;
    const value = build();
    return this.set(key, signature, value, weigh(value));
  }

  remove(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.recency.delete(entry.key);
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
