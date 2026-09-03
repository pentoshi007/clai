import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";
import { transcriptFollowKey } from "../../../src/ui-core/state/transcript-follow-key.js";

function streamText(store: TranscriptStore, seq: EventSequencer, chunks: string[]): void {
  for (const text of chunks) {
    store.dispatch(seq.build("assistant-delta", { text }, undefined));
  }
  store.getState();
}

describe("transcriptFollowKey", () => {
  it("moves while streamed text grows", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
    const before = transcriptFollowKey(store.getState(), true);
    streamText(store, seq, ["he", "llo"]);
    const after = transcriptFollowKey(store.getState(), true);
    expect(after).not.toBe(before);
  });

  it("is stable when unrelated view state changes", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    for (let index = 0; index < 12; index += 1) {
      store.dispatch(
        seq.build("assistant-message", { messageId: seq.ids.message(), text: `old ${index}` }, undefined),
      );
    }
    const before = transcriptFollowKey(store.getState(), true);
    store.toggleOutputGlobal();
    store.toggleThinkingGlobal();
    const after = transcriptFollowKey(store.getState(), true);
    expect(after).toBe(before);
  });

  it("reflects the running flag", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
    expect(transcriptFollowKey(store.getState(), true)).not.toBe(
      transcriptFollowKey(store.getState(), false),
    );
  });
});
