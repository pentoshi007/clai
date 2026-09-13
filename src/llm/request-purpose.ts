import { AsyncLocalStorage } from "node:async_hooks";
import type { CompletionRequestPurpose } from "../types.js";

const requestPurposeStorage = new AsyncLocalStorage<CompletionRequestPurpose>();

export function withRequestPurpose<T>(
  purpose: CompletionRequestPurpose | undefined,
  run: () => T,
): T {
  if (!purpose) return run();
  return requestPurposeStorage.run(purpose, run);
}

export function currentRequestPurpose(): CompletionRequestPurpose | undefined {
  return requestPurposeStorage.getStore();
}
