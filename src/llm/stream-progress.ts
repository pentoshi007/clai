const EMITTED_BYTES = Symbol.for("clai.stream.emittedBytes");

export function markStreamEmittedBytes<E>(error: E, bytes: number): E {
  if (bytes > 0 && typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, EMITTED_BYTES, {
        value: bytes,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
    }
  }
  return error;
}

export function streamEmittedBytes(error: unknown): number {
  if (typeof error !== "object" || error === null) return 0;
  const value = (error as Record<symbol, unknown>)[EMITTED_BYTES];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function streamAlreadyEmitted(error: unknown): boolean {
  return streamEmittedBytes(error) > 0;
}
