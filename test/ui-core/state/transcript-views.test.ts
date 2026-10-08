import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";
import { EMPTY_TRANSCRIPT_STATE } from "../../../src/ui-core/state/transcript-types.js";
import { hydrateFromClassicTranscript } from "../../../src/ui-core/state/transcript-hydrate.js";

describe("independent transcript views", () => {
  it("reads the latest coalesced stream before the notification timer fires", () => {
    const source = new TranscriptStore();
    const view = source.fork();
    const seq = new EventSequencer(asSessionId("buffered-view"));
    try {
      source.dispatch(seq.build("assistant-delta", { text: "latest streamed answer" }, undefined));
      expect(view.transcript.getState().byId).toBe(source.getState().byId);
      expect([...view.transcript.getState().byId.values()]).toContainEqual(expect.objectContaining({ text: "latest streamed answer" }));
    } finally { view.dispose(); }
  });

  it("shares live conversation content while keeping display controls local", () => {
    const source = new TranscriptStore();
    const desktop = source.fork();
    const phone = source.fork();
    const seq = new EventSequencer(asSessionId("views"));
    try {
      desktop.transcript.toggleOutputGlobal();
      phone.transcript.toggleThinkingGlobal();
      source.dispatch(seq.build("turn-started", { prompt: "shared question" }, undefined));
      source.dispatch(seq.build("assistant-delta", { text: "retained_界_🙂" }, undefined));
      source.dispatch(seq.build("notice", { level: "info", text: "settled" }, undefined));
      const a = desktop.transcript.getState();
      const b = phone.transcript.getState();
      expect(a.order).toBe(b.order);
      expect(a.byId).toBe(b.byId);
      expect([...a.byId.values()]).toContainEqual(expect.objectContaining({ kind: "assistant", text: "retained_界_🙂" }));
      expect(a.expandOutputGlobal).toBe(true);
      expect(b.expandOutputGlobal).toBe(false);
      expect(a.expandThinkingGlobal).toBe(false);
      expect(b.expandThinkingGlobal).toBe(true);
      expect(source.getState().expandOutputGlobal).toBe(false);
      a.order.forEach((id) => desktop.transcript.toggleItemOverride(id, false));
      expect(phone.transcript.getState().itemOverrides.size).toBe(0);
      expect(source.getState().itemOverrides.size).toBe(0);
    } finally { desktop.dispose(); phone.dispose(); }
  });

  it("keeps one copy of a 100,000-row transcript across attachment views", () => {
    const source = new TranscriptStore();
    const order = Array.from({ length: 100_000 }, (_, i) => `row-${i}`);
    const byId = new Map(order.map((id, sequence) => [id, { id, kind: "user" as const, text: id, sequence, turnId: undefined, timestamp: 0 }]));
    source.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order, byId });
    const views = Array.from({ length: 8 }, () => source.fork());
    try {
      for (const view of views) {
        expect(view.transcript.getState().order).toBe(order);
        expect(view.transcript.getState().byId).toBe(byId);
      }
      views[0]!.transcript.toggleOutputGlobal();
      expect(views[0]!.transcript.getState().byId).toBe(byId);
      expect(views[1]!.transcript.getState().expandOutputGlobal).toBe(false);
      expect(source.getState().order).toHaveLength(100_000);
    } finally { views.forEach((view) => view.dispose()); }
  });

  it("retains saved history and propagates conversation resets without a second writer", () => {
    const source = new TranscriptStore();
    const persisted = [{ id: "old", kind: "user" as const, text: "saved question", done: true }];
    source.hydrate(hydrateFromClassicTranscript(persisted).state, { persistBase: persisted });
    const desktop = source.fork();
    const phone = source.fork();
    try {
      expect(phone.transcript.mergePersistSnapshot([])).toEqual(persisted);
      desktop.transcript.reset();
      expect(source.getState().order).toEqual([]);
      expect(phone.transcript.getState().order).toEqual([]);
      expect(source.mergePersistSnapshot([])).toEqual([]);
      desktop.dispose();
      const seq = new EventSequencer(asSessionId("after-detach"));
      source.dispatch(seq.build("turn-started", { prompt: "still running" }, undefined));
      expect(phone.transcript.getState().order).toHaveLength(1);
    } finally { desktop.dispose(); phone.dispose(); }
  });
});
