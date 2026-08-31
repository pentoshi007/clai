import { describe, expect, it, vi } from "vitest";
import type {
  SessionController,
  SessionState,
} from "../../../src/app/controllers/session-controller.js";
import { createSessionStateStore } from "../../../src/ui-core/react/use-session-state.js";

function snapshot(sessionId: string): SessionState {
  return { sessionId } as SessionState;
}

describe("session state external store", () => {
  it("reconciles a mutation before subscription and tracks later updates", () => {
    const states = [snapshot("before"), snapshot("hydrated"), snapshot("live")];
    const listeners = new Set<() => void>();
    let index = 0;
    const source = {
      getState: () => states[index]!,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } satisfies Pick<SessionController, "getState" | "subscribe">;
    const store = createSessionStateStore(source);

    expect(store.getSnapshot().sessionId).toBe("before");
    index = 1;
    const changed = vi.fn();
    const unsubscribe = store.subscribe(changed);

    expect(store.getSnapshot().sessionId).toBe("hydrated");
    expect(changed).toHaveBeenCalledOnce();

    index = 2;
    for (const listener of listeners) listener();
    expect(store.getSnapshot().sessionId).toBe("live");
    expect(changed).toHaveBeenCalledTimes(2);

    unsubscribe();
    index = 0;
    for (const listener of listeners) listener();
    expect(store.getSnapshot().sessionId).toBe("live");
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
