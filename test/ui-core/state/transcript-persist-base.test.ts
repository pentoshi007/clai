import { describe, expect, it } from "vitest";
import { asSessionId, asToolCallId } from "../../../src/app/events/app-event.js";
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

  it("preserves pre-compaction history in the persisted record", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "build a provider" }, undefined));
    store.dispatch(
      seq.build(
        "assistant-delta",
        { text: "Working on it" },
        undefined,
      ),
    );
    store.dispatch(
      seq.build(
        "compaction-started",
        { compactionId: "c1", beforeTokens: 5000 },
        undefined,
      ),
    );
    store.dispatch(
      seq.build(
        "compaction-completed",
        {
          compactionId: "c1",
          summary: "Session memory\n\n- built provider skeleton",
          beforeTokens: 5000,
          afterTokens: 900,
        },
        undefined,
      ),
    );

    const persisted = snapshot(store);
    const compacted = persisted.find((item) => item.kind === "compacted");
    expect(compacted).toBeDefined();
    expect(
      compacted && compacted.kind === "compacted"
        ? compacted.originalItems.map((item) => item.kind)
        : [],
    ).toContain("user");
    expect(
      compacted && compacted.kind === "compacted"
        ? compacted.originalItems.map((item) => item.kind)
        : [],
    ).toContain("assistant");
  });

  it("round-trips compacted originalItems through a resume", () => {
    const withCompaction: ClassicTranscriptItem[] = [
      user("u1", "original prompt"),
      {
        kind: "compacted",
        id: "compacted-c1",
        summary: "Session memory\n\n- earlier work",
        originalItems: [user("u0", "even earlier"), assistant("a0", "early answer")],
        done: true,
        beforeTokens: 8000,
        afterTokens: 1200,
      },
      assistant("a1", "post-compaction answer"),
    ];
    const store = new TranscriptStore();
    store.hydrate(hydrateFromClassicTranscript(withCompaction).state, {
      persistBase: withCompaction,
    });

    const persisted = snapshot(store);
    const compacted = persisted.find((item) => item.kind === "compacted");
    expect(compacted).toBeDefined();
    if (compacted && compacted.kind === "compacted") {
      expect(compacted.originalItems.map((item) => item.id)).toEqual([
        "u0",
        "a0",
      ]);
    }
    expect(persisted.map((item) => item.id)).toEqual([
      "u1",
      "compacted-c1",
      "a1",
    ]);
  });

  it("bounds compacted originalItems so long sessions stay small", () => {
    const store = new TranscriptStore(100000, 0);
    const seq = new EventSequencer(asSessionId("s1"));
    const spool = new Map<string, string>();
    for (let i = 0; i < 500; i += 1) {
      const id = `tool-${i}`;
      store.dispatch(
        seq.build(
          "tool-call",
          { toolCallId: asToolCallId(id), name: "shell.exec", argsDisplay: `cmd ${i}` },
          undefined,
        ),
      );
      spool.set(id, "X".repeat(256 * 1024));
    }
    store.dispatch(
      seq.build("compaction-started", { compactionId: "c1", beforeTokens: 500000 }, undefined),
    );
    store.dispatch(
      seq.build(
        "compaction-completed",
        { compactionId: "c1", summary: "mem", beforeTokens: 500000, afterTokens: 20000 },
        undefined,
      ),
    );

    const persisted = store.mergePersistSnapshot(
      serializeForHistory(store.getState(), (id) => spool.get(id) ?? ""),
    );
    const compacted = persisted.find((item) => item.kind === "compacted");
    expect(compacted).toBeDefined();
    if (compacted && compacted.kind === "compacted") {
      const bytes = JSON.stringify(compacted.originalItems).length;
      expect(bytes).toBeLessThanOrEqual(2_100_000);
      expect(compacted.originalItems.length).toBeGreaterThan(0);
    }
  });
});
