export const MODEL_LIST_TTL_MS = 2 * 60 * 1000;

const MAX_KEYS = 16;

interface Entry<T> {
  readonly value: T;
  readonly at: number;
}

export interface ModelListCache<T> {
  fresh(key?: string, maxAgeMs?: number): T | undefined;
  stale(key?: string): T | undefined;
  store(value: T, key?: string): void;
  clear(): void;
}

const invalidators = new Map<string, Set<() => void>>();
const fallbackLists = new WeakSet<readonly string[]>();

export function isModelListFresh(fetchedAt: number, maxAgeMs: number = MODEL_LIST_TTL_MS): boolean {
  return Date.now() - fetchedAt < maxAgeMs;
}

export function onModelListInvalidated(provider: string, invalidate: () => void): void {
  const registered = invalidators.get(provider) ?? new Set<() => void>();
  registered.add(invalidate);
  invalidators.set(provider, registered);
}

export function invalidateModelLists(provider?: string): void {
  for (const [id, registered] of invalidators) {
    if (provider !== undefined && id !== provider) continue;
    for (const invalidate of registered) invalidate();
  }
}

export function modelListCache<T = string[]>(
  provider: string,
  options: { readonly detached?: boolean } = {},
): ModelListCache<T> {
  const entries = new Map<string, Entry<T>>();
  const cache: ModelListCache<T> = {
    fresh(key = "", maxAgeMs = MODEL_LIST_TTL_MS) {
      const entry = entries.get(key);
      return entry && isModelListFresh(entry.at, maxAgeMs) ? entry.value : undefined;
    },
    stale(key = "") {
      return entries.get(key)?.value;
    },
    store(value, key = "") {
      if (Array.isArray(value) && value.length === 0) return;
      entries.delete(key);
      entries.set(key, { value, at: Date.now() });
      while (entries.size > MAX_KEYS) entries.delete(entries.keys().next().value!);
    },
    clear() {
      entries.clear();
    },
  };
  if (!options.detached) onModelListInvalidated(provider, cache.clear);
  return cache;
}

export function fallbackModelList(models: readonly string[]): string[] {
  const list = [...models];
  fallbackLists.add(list);
  return list;
}

export function isFallbackModelList(models: readonly string[]): boolean {
  return fallbackLists.has(models);
}
