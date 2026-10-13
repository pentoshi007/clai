import { describe, expect, it } from "vitest";
import { PromptHistory } from "../../../src/ui-core/composer/prompt-history.js";
import { bindSavedPromptHistory } from "../../../src/ui-core/composer/saved-prompt-history.js";
import { SessionPromptStore } from "../../../src/store/session-prompts.js";
import type { SessionController } from "../../../src/app/controllers/session-controller.js";

function fixture(enabled = true, initial?: SessionPromptStore) {
  let store = initial ?? new SessionPromptStore(`current-${Math.random()}`);
  const listeners = new Set<() => void>();
  const session = {
    get promptHistory() { return store; },
    isPromptHistoryEnabled: () => enabled,
    subscribe(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  const history = new PromptHistory();
  const dispose = bindSavedPromptHistory(history, session as Pick<SessionController, "promptHistory" | "isPromptHistoryEnabled" | "subscribe">);
  return {
    history, dispose,
    enable(value: boolean) { enabled = value; for (const listener of listeners) listener(); },
    switchStore(value: SessionPromptStore) { store = value; for (const listener of listeners) listener(); },
  };
}

describe("saved composer prompt history", () => {
  it("does not load saved prompts when private mode or --no-history disables history", async () => {
    await new SessionPromptStore(`saved-private-${Math.random()}`).append({ content: "Saved public prompt" });
    const f = fixture(false);
    try {
      expect(await f.history.prevWithSaved("draft")).toBeUndefined();
      f.history.push("Private current-launch prompt");
      expect(await f.history.prevWithSaved("draft")).toBe("Private current-launch prompt");
    } finally { f.dispose(); }
  });

  it("drops loaded saved prompts as soon as history is disabled", async () => {
    const old = new SessionPromptStore(`saved-disable-${Math.random()}`);
    await old.append({ content: "Latest saved public prompt" });
    const f = fixture(true, old);
    try {
      expect(await f.history.prevWithSaved("draft")).toBe("Latest saved public prompt");
      f.enable(false);
      expect(await f.history.prevWithSaved("draft")).toBeUndefined();
    } finally { f.dispose(); }
  });

  it("rebinds recall when loading a saved session without duplicating current-launch entries", async () => {
    const f = fixture();
    try {
      f.history.push("Local prompt");
      const restored = new SessionPromptStore(`restored-${Math.random()}`);
      await restored.append({ content: "Prompt from the restored journal" });
      f.switchStore(restored);
      expect(await f.history.prevWithSaved("draft")).toBe("Prompt from the restored journal");
      expect(await f.history.nextWithSaved()).toBe("draft");
    } finally { f.dispose(); }
  });
});
