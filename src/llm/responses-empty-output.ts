const EMPTY_OUTPUT = Symbol.for("clai.responses.emptyOutput");

export function markResponsesEmptyOutput<E>(error: E): E {
  if (typeof error === "object" && error !== null) {
    try {
      Object.defineProperty(error, EMPTY_OUTPUT, {
        value: true,
        enumerable: false,
        configurable: true,
        writable: true,
      });
    } catch {
    }
  }
  return error;
}

export function isResponsesEmptyOutput(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as Record<symbol, unknown>)[EMPTY_OUTPUT] === true;
}
