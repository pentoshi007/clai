import { describe, expect, it } from "vitest";
import { OutputSpool } from "../../../src/app/events/event-buffer.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../../src/app/ports/transcript-item.js";
import { absorbPersistedTranscript } from "../../../src/ui-core/bootstrap/session-merge.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../../../src/ui-core/state/transcript-hydrate.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";

const user = (id: string, text: string): ClassicTranscriptItem => ({ kind: "user", id, text, done: true });
const assistant = (id: string, text: string): ClassicTranscriptItem => ({ kind: "assistant", id, text, streaming: false, done: true });

function liveStore(items: readonly ClassicTranscriptItem[]) {
  const store = new TranscriptStore();
  const hydrated = hydrateFromClassicTranscript(items);
  store.hydrate({
    ...hydrated.state,
    order: [...hydrated.state.order, "notice-1"],
    byId: new Map([...hydrated.state.byId, ["notice-1", { kind: "notice", id: "notice-1", level: "info", text: "live notice", sequence: 99, timestamp: 99, turnId: undefined }]]),
  }, { persistBase: items });
  return store;
}

describe("inserting persisted items from another writer", () => {
  it("anchors late items after their nearest shared predecessor and keeps live-only items and overrides", () => {
    const shared = [user("u1", "first"), assistant("a1", "answer"), user("u2", "resumed prompt")];
    const store = liveStore(shared);
    store.toggleItemOverride("a1", false);
    const spool = new OutputSpool();
    const current = store.mergePersistSnapshot(serializeForHistory(store.getState(), (id) => spool.peekTail(id)));
    const incoming = [user("u0", "older"), ...shared.slice(0, 2), assistant("late-1", "late answer"), user("late-2", "late prompt"), shared[2]!];
    const added = absorbPersistedTranscript(store, spool, current, incoming);
    expect(added.map((item) => item.id)).toEqual(["u0", "late-1", "late-2"]);
    const state = store.getState();
    expect(state.order).toEqual(["u0", "u1", "a1", "late-1", "late-2", "u2", "notice-1"]);
    expect(state.itemOverrides.get("a1")).toBe(true);
    expect(state.byId.get("late-1")).toMatchObject({ kind: "assistant", text: "late answer" });
    const saved = store.mergePersistSnapshot(serializeForHistory(store.getState(), (id) => spool.peekTail(id))).map((item) => item.id);
    expect(saved).toEqual(["u0", "u1", "a1", "late-1", "late-2", "u2"]);
    expect(absorbPersistedTranscript(store, spool, store.mergePersistSnapshot(serializeForHistory(store.getState(), (id) => spool.peekTail(id))), incoming)).toEqual([]);
    expect(store.getState().order).toHaveLength(7);
  });

  it("restores outputs for merged tool items and reaches forked views", () => {
    const store = liveStore([user("u1", "first")]);
    const view = store.fork();
    const spool = new OutputSpool();
    const tool: ClassicTranscriptItem = { kind: "tool", id: "late-tool", name: "shell.exec", argsDisplay: "npm test", output: "all green", status: "ok", done: true };
    absorbPersistedTranscript(store, spool, store.mergePersistSnapshot(serializeForHistory(store.getState(), () => "")), [user("u1", "first"), tool]);
    expect(view.transcript.getState().order).toContain("late-tool");
    const item = store.getState().byId.get("late-tool");
    expect(item?.kind).toBe("tool");
    if (item?.kind === "tool") expect(spool.tail(item.toolCallId)).toBe("all green");
    view.dispose();
  });
});
