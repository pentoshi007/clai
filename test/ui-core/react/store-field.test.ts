import { describe, expect, it, vi } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";
import { createFieldSnapshot } from "../../../src/ui-core/react/use-transcript-meta.js";

describe("createFieldSnapshot", () => {
  it("keeps identity while the selected field is unchanged", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    const snapshot = createFieldSnapshot(
      () => store.getState(),
      (state) => state.expandThinkingGlobal,
    );
    const before = snapshot();
    store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
    store.dispatch(seq.build("assistant-delta", { text: "he" }, undefined));
    store.dispatch(seq.build("assistant-delta", { text: "llo" }, undefined));
    store.getState();
    expect(snapshot()).toBe(before);
  });

  it("reflects field changes", () => {
    const store = new TranscriptStore();
    const snapshot = createFieldSnapshot(
      () => store.getState(),
      (state) => state.expandOutputGlobal,
    );
    expect(snapshot()).toBe(false);
    store.toggleOutputGlobal();
    expect(snapshot()).toBe(true);
  });

  it("fires a narrow subscriber only when its field changes during streaming", () => {
    vi.useFakeTimers();
    try {
      const store = new TranscriptStore();
      const seq = new EventSequencer(asSessionId("s1"));
      const snapshot = createFieldSnapshot(
        () => store.getState(),
        (state) => state.expandThinkingGlobal,
      );
      let renders = 0;
      let current = snapshot();
      store.subscribe(() => {
        const next = snapshot();
        if (!Object.is(next, current)) {
          current = next;
          renders += 1;
        }
      });
      store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
      for (let index = 0; index < 30; index += 1) {
        store.dispatch(seq.build("assistant-delta", { text: `chunk${index} ` }, undefined));
        vi.advanceTimersByTime(16);
      }
      store.getState();
      expect(renders).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
