import { useMemo, useSyncExternalStore } from "react";
import type {
  SessionController,
  SessionState,
} from "../../app/controllers/session-controller.js";

type SessionStateSource = Pick<SessionController, "getState" | "subscribe">;

export interface SessionStateStore {
  readonly getSnapshot: () => SessionState;
  readonly subscribe: (listener: () => void) => () => void;
}

export function createSessionStateStore(
  session: SessionStateSource,
): SessionStateStore {
  let snapshot = session.getState();
  let unsubscribeSource: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const update = (): void => {
    snapshot = session.getState();
    for (const listener of listeners) listener();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      unsubscribeSource = session.subscribe(update);
      update();
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) {
        unsubscribeSource?.();
        unsubscribeSource = undefined;
      }
    };
  };

  return {
    getSnapshot: () => snapshot,
    subscribe,
  };
}

export function useSessionState(session: SessionController): SessionState {
  const store = useMemo(() => createSessionStateStore(session), [session]);
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
