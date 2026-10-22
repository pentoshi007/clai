import { describe, expect, it, vi } from "vitest";
import { createCompactionPagerSource } from "../../../src/ui-core/rendering/compaction-pager-source.js";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { createHarness } from "../../classic/app/harness.js";

function fixture() {
  const h = createHarness();
  const seq = new EventSequencer(asSessionId(h.services.session.sessionId));
  const emit = h.services.transcript.dispatch.bind(h.services.transcript);
  emit(seq.build("compaction-started", { compactionId: "live", beforeTokens: 10_000 }));
  const item = h.services.transcript.getState().byId.get("compacted-live");
  if (item?.kind !== "compacted") throw new Error("missing compaction");
  return { h, seq, emit, source: createCompactionPagerSource(h.services, item) };
}

describe("live compaction source", () => {
  it("streams appended/replaced summaries, exposes failures, and unsubscribes on close", async () => {
    const { h, seq, emit, source } = fixture();
    const subscribe = h.services.transcript.subscribe.bind(h.services.transcript);
    const unwatch = vi.fn();
    vi.spyOn(h.services.transcript, "subscribe").mockImplementation((listener) => {
      const unsubscribe = subscribe(listener);
      return () => { unsubscribe(); unwatch(); };
    });
    const changed = vi.fn();
    source.watch!(changed);
    try {
      expect((await source.readTail!()).body).toContain("waiting for compaction");
      expect(source.isGrowing?.()).toBe(true);
      emit(seq.build("compaction-delta", { compactionId: "live", text: "first delta" }));
      await expect.poll(() => changed.mock.calls.length).toBeGreaterThan(0);
      expect(await source.readAll()).toBe("first delta");
      emit(seq.build("compaction-delta", { compactionId: "live", text: "replacement delta", replace: true }));
      expect((await source.readPage(0)).body).toBe("replacement delta");
      expect((await source.search("replacement"))?.body).toBe("replacement delta");
      emit(seq.build("compaction-failed", { compactionId: "live", message: "cancelled" }));
      expect(source.isGrowing?.()).toBe(false);
      expect(await source.readAll()).toContain("cancelled");
      source.dispose();
      expect(unwatch).toHaveBeenCalledOnce();
      expect(() => source.readAll()).toThrow("closed");
    } finally { source.dispose(); h.dispose(); }
  });

  it("keeps the final summary but never switches to another session's compaction", async () => {
    const { h, seq, emit, source } = fixture();
    try {
      emit(seq.build("compaction-completed", { compactionId: "live", summary: "FINAL SUMMARY", beforeTokens: 10_000, afterTokens: 100, contextScope: "message-history" }));
      expect(await source.readAll()).toBe("FINAL SUMMARY");
      h.services.session.reset({ mintNewId: true });
      h.services.transcript.reset();
      expect(source.isGrowing?.()).toBe(false);
      expect(await source.readAll()).toBe("FINAL SUMMARY");
    } finally { source.dispose(); h.dispose(); }
  });
});
