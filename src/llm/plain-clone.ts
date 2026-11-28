export function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  if (value === null || typeof value !== "object") return value;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "__proto__") {
      Object.defineProperty(copy, key, { value: clonePlain(entry), enumerable: true, writable: true, configurable: true });
    } else {
      copy[key] = clonePlain(entry);
    }
  }
  return copy as T;
}
