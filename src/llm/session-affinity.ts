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

export function currentIsolatedSessionAffinity(): string | undefined {
  const session = currentSessionAffinity();
  return session && (session.includes(":subagent:") || session.endsWith(":auxiliary")) ? session : undefined;
}
