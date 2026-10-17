import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import type { TranscriptItem } from "../../../src/app/ports/transcript-item.js";
import { flattenTranscriptHistory } from "../../../src/ui-core/state/transcript-history.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../../../src/ui-core/state/transcript-hydrate.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";

const user = (id: string, text = id): TranscriptItem => ({ id, kind: "user", text, done: true });
const compacted = (id: string, originalItems: TranscriptItem[]): TranscriptItem => ({ id, kind: "compacted", summary: id, originalItems, done: true });

describe("lossless compaction history", () => {
  it("keeps serialization linear through 100 compactions without duplicating original text", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("long-session"));
    const text = "complete 日本語 🧪\n".repeat(4_000);
    store.dispatch(seq.build("turn-started", { prompt: text }, undefined));
    for (let i = 0; i < 100; i += 1) {
      store.dispatch(seq.build("compaction-completed", { compactionId: `c${i}`, summary: `memory ${i}`, beforeTokens: 1000, afterTokens: 100 }, undefined));
    }
    const saved = serializeForHistory(store.getState(), () => "");
    expect(saved).toHaveLength(101);
    expect(saved[0]).toMatchObject({ text });
    expect(saved.filter((item) => item.kind === "compacted").every((item) => item.originalItems.length === 0)).toBe(true);
    expect(JSON.stringify(saved).length).toBeLessThan(text.length + 35_000);
    const restored = hydrateFromClassicTranscript(saved);
    expect(restored.state.order).toHaveLength(101);
    expect(restored.state.byId.get(restored.state.order[0]!)).toMatchObject({ text });
    expect(serializeForHistory(store.getState(), () => "")[0]).toBe(saved[0]);
  });

  it("hoists all legacy originals once without clipping long content", () => {
    const text = "🙂漢字\n".repeat(30_000);
    const first = user("first", text);
    const old = compacted("old", [first]);
    const last = compacted("last", [first, old, user("middle")]);
    const flat = flattenTranscriptHistory([last, user("end")]);
    expect(flat.map((item) => item.id)).toEqual(["first", "old", "middle", "last", "end"]);
    expect(flat[0]).toMatchObject({ text });
    expect(flattenTranscriptHistory(flat)).toEqual(flat);
    expect(hydrateFromClassicTranscript([last, user("end")]).state.order).toEqual(flat.map((item) => item.id));
  });

  it("uses authoritative root revisions and preserves their ordering", () => {
    const current = user("same", "full current text");
    const history = [current, compacted("c", [user("same", "old prefix"), user("legacy")]), user("tail")];
    const flat = flattenTranscriptHistory(history);
    expect(flat.map((item) => item.id)).toEqual(["same", "legacy", "c", "tail"]);
    expect(flat[0]).toBe(current);
  });

  it("handles deeply nested legacy data without recursive stack overflow", () => {
    let item = user("first", "untouched");
    for (let i = 0; i < 10_000; i += 1) item = compacted(`c${i}`, [item]);
    const flat = flattenTranscriptHistory([item]);
    expect(flat).toHaveLength(10_001);
    expect(flat[0]).toMatchObject({ text: "untouched" });
  });
});

it("keeps the latest authoritative root revision when legacy roots repeat an ID", () => {
  const latest = user("same", "complete revised 日本語 🧪");
  const flat = flattenTranscriptHistory([user("same", "old"), compacted("c", [user("same", "nested")]), latest]);
  expect(flat.map((item) => item.id)).toEqual(["same", "c"]);
  expect(flat[0]).toBe(latest);
});
