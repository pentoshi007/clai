import { AsyncLocalStorage } from "node:async_hooks";

const sessionAffinityStorage = new AsyncLocalStorage<string>();

export function withSessionAffinity<T>(
  sessionId: string,
  run: () => T,
): T {
  return sessionAffinityStorage.run(sessionId, run);
}

export function currentSessionAffinity(): string | undefined {
  return sessionAffinityStorage.getStore();
}
