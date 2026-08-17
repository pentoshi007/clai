import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../../src/app/ports/transcript-item.js";
import {
  hydrateFromClassicTranscript,
  serializeForHistory,
} from "../../../src/ui-core/state/transcript-hydrate.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";

function user(id: string, text: string): ClassicTranscriptItem {
  return { kind: "user", id, text, done: true };
}

function assistant(id: string, text: string): ClassicTranscriptItem {
  return { kind: "assistant", id, text, streaming: false, done: true };
}

function fullTranscript(): ClassicTranscriptItem[] {
  return [
    user("u1", "first prompt"),
    assistant("a1", "first answer"),
    user("u2", "second prompt"),
    assistant("a2", "second answer"),
    user("u3", "third prompt"),
  ];
}

function snapshot(store: TranscriptStore): ClassicTranscriptItem[] {
  return store.mergePersistSnapshot(
    serializeForHistory(store.getState(), () => ""),
  );
}

describe("transcript persist base", () => {
  it("passes snapshots through unchanged before any resume", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "hello" }, undefined));
    const serialized = serializeForHistory(store.getState(), () => "");
    expect(store.mergePersistSnapshot(serialized)).toBe(serialized);
  });

  it("keeps the full on-disk transcript when the resumed view is bounded", () => {
    const full = fullTranscript();
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript(full.slice(2)).state, {
      persistBase: full,
    });

    const items = snapshot(store);
    expect(items.map((item) => item.id)).toEqual(["u1", "a1", "u2", "a2", "u3"]);
    expect(items[0]).toBe(full[0]);
  });

  it("appends post-resume items once without duplicating hydrated ones", () => {
    const full = fullTranscript();
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript(full.slice(2)).state, {
      persistBase: full,
    });
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "new question" }, undefined));

    const items = snapshot(store);
    expect(items).toHaveLength(6);
    expect(items.slice(0, 5).map((item) => item.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
    ]);
    expect(items[5]).toMatchObject({ kind: "user", text: "new question" });
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  it("keeps the base across in-session rehydrates that omit persistBase", () => {
    const full = fullTranscript();
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript(full.slice(2)).state, {
      persistBase: full,
    });
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "again" }, undefined));
    store.hydrate(store.getState(), { rebaseSequence: false });

    const items = snapshot(store);
    expect(items.slice(0, 5).map((item) => item.id)).toEqual([
      "u1",
      "a1",
      "u2",
      "a2",
      "u3",
    ]);
    expect(items.at(-1)).toMatchObject({ kind: "user", text: "again" });
  });

  it("drops message-reconstructed items when the session had no transcript", () => {
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript([user("h1", "old")]).state, {
      persistBase: undefined,
    });
    expect(snapshot(store)).toEqual([]);

    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "fresh" }, undefined));
    const items = snapshot(store);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "fresh" });
  });

  it("reset clears the base so a cleared session persists only new items", () => {
    const full = fullTranscript();
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript(full.slice(2)).state, {
      persistBase: full,
    });
    store.reset();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "after clear" }, undefined));

    const items = snapshot(store);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "user", text: "after clear" });
  });
});
