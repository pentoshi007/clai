import { describe, expect, it, vi } from "vitest";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
} from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { EMPTY_STRIP_STREAM } from "../../../src/ui-core/rendering/incremental-strip.js";
import { TranscriptStore } from "../../../src/ui-core/state/transcript-store.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  isItemExpanded,
  type AssistantItem,
  type CompactedItem,
  type ThinkingItem,
  type ToolItem,
  type TranscriptState,
  type UserItem,
} from "../../../src/ui-core/state/transcript-types.js";

describe("TranscriptStore (V2-050)", () => {
  it("notifies subscribers only on state change", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    let notifications = 0;
    store.subscribe(() => (notifications += 1));

    store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
    expect(notifications).toBe(1);

    // plan-updated/confirm-requested don't change transcript.order, but they
    // do bump lastSequence, which is a real state change and must notify.
    store.dispatch(seq.build("confirm-requested", { requestId: "r1", kind: "tool", prompt: "?" }, undefined));
    expect(notifications).toBe(2);
  });

  it("toggleThinkingGlobal/toggleOutputGlobal flip the defaults (CHAT-005/006)", () => {
    const store = new TranscriptStore();
    expect(store.getState().expandThinkingGlobal).toBe(false);
    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(true);
    store.toggleOutputGlobal();
    expect(store.getState().expandOutputGlobal).toBe(true);
  });

  it("Ctrl+T reclaims manual thinking overrides without touching tool overrides", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("thinking-block", { messageId: seq.ids.message(), content: "x" }, undefined));
    store.dispatch(
      seq.build(
        "tool-call",
        { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a" },
        undefined,
      ),
    );
    const thinking = [...store.getState().byId.values()].find(
      (item): item is ThinkingItem => item.kind === "thinking",
    )!;
    const tool = [...store.getState().byId.values()].find(
      (item): item is ToolItem => item.kind === "tool",
    )!;

    store.toggleItemOverride(thinking.id, false);
    store.toggleItemOverride(tool.id, false);
    expect(isItemExpanded(store.getState(), thinking)).toBe(true);

    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(false);
    expect(isItemExpanded(store.getState(), thinking)).toBe(false);
    expect(store.getState().itemOverrides.has(thinking.id)).toBe(false);
    expect(store.getState().itemOverrides.get(tool.id)).toBe(true);

    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(true);
    expect(isItemExpanded(store.getState(), thinking)).toBe(true);

    store.toggleItemOverride(thinking.id, true);
    expect(isItemExpanded(store.getState(), thinking)).toBe(false);
    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(true);
    expect(isItemExpanded(store.getState(), thinking)).toBe(true);
    expect(store.getState().itemOverrides.has(thinking.id)).toBe(false);
    expect(store.getState().itemOverrides.get(tool.id)).toBe(true);
  });

  it("coalesces streaming deltas into one deferred notify but keeps state exact", () => {
    vi.useFakeTimers();
    try {
      const store = new TranscriptStore();
      const seq = new EventSequencer(asSessionId("s1"));
      let notifications = 0;
      store.subscribe(() => (notifications += 1));

      store.dispatch(seq.build("assistant-delta", { text: "he" }, undefined));
      store.dispatch(seq.build("assistant-delta", { text: "llo" }, undefined));
      store.dispatch(seq.build("assistant-delta", { text: " world" }, undefined));
      // State is up to date immediately; notifications are still batched.
      expect(notifications).toBe(0);
      const pending = [...store.getState().byId.values()][0];
      expect(pending).toMatchObject({ kind: "assistant", text: "hello world" });

      vi.advanceTimersByTime(16);
      expect(notifications).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes a pending delta notify immediately when a structural event lands", () => {
    vi.useFakeTimers();
    try {
      const store = new TranscriptStore();
      const seq = new EventSequencer(asSessionId("s1"));
      let notifications = 0;
      store.subscribe(() => (notifications += 1));

      store.dispatch(seq.build("assistant-delta", { text: "hi" }, undefined));
      expect(notifications).toBe(0);
      store.dispatch(
        seq.build("assistant-message", { messageId: seq.ids.message(), text: "hi" }, undefined),
      );
      // Structural event flushes the batched delta plus itself in one notify.
      expect(notifications).toBe(1);
      vi.advanceTimersByTime(32);
      expect(notifications).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset clears all items and subscribers still fire", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("turn-started", { prompt: "hi" }, undefined));
    expect(store.getState().order).toHaveLength(1);
    store.reset();
    expect(store.getState().order).toHaveLength(0);
  });

  it("tool item override falls back to the output global independent of thinking", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(
      seq.build("tool-call", { toolCallId: asToolCallId("c1"), name: "fs.read", argsDisplay: "a" }, undefined),
    );
    const item = [...store.getState().byId.values()][0] as ToolItem;
    expect(isItemExpanded(store.getState(), item)).toBe(false);
    store.toggleOutputGlobal();
    expect(isItemExpanded(store.getState(), item)).toBe(true);
  });

  it("compacted cards share Ctrl+O expand with tool output (CHAT-007)", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(
      seq.build(
        "compacted",
        {
          summary: "Session memory from compacted earlier turns:\n\nUser asked for X.",
          beforeTokens: 12_000,
          afterTokens: 2_000,
        },
        undefined,
      ),
    );
    const item = [...store.getState().byId.values()][0]!;
    expect(item.kind).toBe("compacted");
    expect(isItemExpanded(store.getState(), item)).toBe(false);
    store.toggleOutputGlobal();
    expect(isItemExpanded(store.getState(), item)).toBe(true);
    // Per-item click override still works while global is on.
    store.toggleItemOverride(item.id, true);
    expect(isItemExpanded(store.getState(), item)).toBe(false);
  });

  it("applies mixed delta bursts exactly, including compaction replacement", () => {
    let now = 100;
    const store = new TranscriptStore();
    const seq = new EventSequencer(
      asSessionId("s1"),
      undefined,
      { now: () => now++ },
    );
    const turnId = asTurnId("turn-1");

    store.dispatch(
      seq.build(
        "compaction-started",
        { compactionId: "compact-1", beforeTokens: 20_000 },
        turnId,
      ),
    );
    store.dispatch(
      seq.build(
        "compaction-delta",
        { compactionId: "compact-1", text: "draft" },
        turnId,
      ),
    );
    store.dispatch(
      seq.build(
        "compaction-delta",
        { compactionId: "compact-1", text: "final", replace: true },
        turnId,
      ),
    );
    store.dispatch(
      seq.build(
        "compaction-delta",
        { compactionId: "compact-1", text: " summary" },
        turnId,
      ),
    );
    store.dispatch(
      seq.build(
        "thinking-delta",
        { reasoningId: "reason-1", text: "rea" },
        turnId,
      ),
    );
    store.dispatch(
      seq.build(
        "thinking-delta",
        { reasoningId: "reason-1", text: "son" },
        turnId,
      ),
    );
    const whitespace = seq.build("assistant-delta", { text: " " }, turnId);
    const visible = seq.build("assistant-delta", { text: "answer" }, turnId);
    store.dispatch(whitespace);
    store.dispatch(visible);

    const state = store.getState();
    const items = [...state.byId.values()];
    const compacted = items.find(
      (item): item is CompactedItem => item.kind === "compacted",
    );
    const thinking = items.find(
      (item): item is ThinkingItem => item.kind === "thinking",
    );
    const assistant = items.find(
      (item): item is AssistantItem => item.kind === "assistant",
    );
    expect(compacted?.summary).toBe("final summary");
    expect(thinking?.content).toBe("reason");
    expect(thinking?.endedAt).toBe(visible.timestamp);
    expect(assistant?.text).toBe(" answer");
    expect(state.lastSequence).toBe(visible.sequence);
  });

  it("rejects queued sequence gaps synchronously without losing accepted deltas", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    const first = seq.build("assistant-delta", { text: "a" }, undefined);
    const missing = seq.build("assistant-delta", { text: "b" }, undefined);
    const gap = seq.build("assistant-delta", { text: "c" }, undefined);

    store.dispatch(first);
    expect(() => store.dispatch(gap)).toThrow(
      "transcript sequence gap: expected 2 but received 3",
    );
    store.dispatch(missing);
    store.dispatch(gap);

    const item = [...store.getState().byId.values()][0] as AssistantItem;
    expect(item.text).toBe("abc");
    expect(store.getState().lastSequence).toBe(3);
  });

  it("ignores duplicate queued events without duplicating content or notifications", () => {
    vi.useFakeTimers();
    try {
      const store = new TranscriptStore();
      const seq = new EventSequencer(asSessionId("s1"));
      const event = seq.build("assistant-delta", { text: "once" }, undefined);
      let notifications = 0;
      store.subscribe(() => (notifications += 1));

      store.dispatch(event);
      store.dispatch(event);
      expect((([...store.getState().byId.values()][0]) as AssistantItem).text).toBe(
        "once",
      );
      vi.advanceTimersByTime(16);
      expect(notifications).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prunes every id-keyed map when low-watermark eviction removes rows", () => {
    const store = new TranscriptStore(10);
    const users: UserItem[] = Array.from({ length: 10 }, (_, index) => ({
      id: `user-${index}`,
      sequence: index + 1,
      turnId: undefined,
      timestamp: index + 1,
      kind: "user",
      text: `prompt-${index}`,
    }));
    const hydrated: TranscriptState = {
      ...EMPTY_TRANSCRIPT_STATE,
      order: users.map((item) => item.id),
      byId: new Map(users.map((item) => [item.id, item])),
      lastSequence: users.length,
      assistantStripStreams: new Map(
        users.map((item) => [item.id, EMPTY_STRIP_STREAM]),
      ),
    };
    store.hydrate(hydrated);
    store.toggleItemOverride(users[0]!.id, false);
    store.toggleItemOverride(users[9]!.id, false);
    store.toggleFileDiffOverride(users[0]!.id, true);
    store.toggleFileDiffOverride(users[9]!.id, true);

    const seq = new EventSequencer(asSessionId("s1"));
    for (let index = 0; index < users.length; index += 1) {
      seq.build("status", { text: `skip-${index}` }, undefined);
    }
    store.dispatch(
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "newest" },
        undefined,
      ),
    );

    const state = store.getState();
    const retained = new Set(state.order);
    expect(state.order.length).toBeGreaterThan(0);
    expect(state.order.length).toBeLessThanOrEqual(10);
    expect(retained.has(users[0]!.id)).toBe(false);
    for (const id of state.byId.keys()) expect(retained.has(id)).toBe(true);
    for (const id of state.itemOverrides.keys()) expect(retained.has(id)).toBe(true);
    for (const id of state.fileDiffOverrides.keys()) expect(retained.has(id)).toBe(true);
    for (const id of state.assistantStripStreams.keys()) {
      expect(retained.has(id)).toBe(true);
    }
  });

});

describe("thinking focus", () => {
  function storeWithThinking(count: number): {
    store: TranscriptStore;
    ids: string[];
  } {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s-focus"));
    // One thinking block per turn: consecutive blocks in a single turn merge
    // into the same pending item.
    for (let index = 0; index < count; index += 1) {
      store.dispatch(seq.build("turn-started", { prompt: `hi ${index}` }, undefined));
      store.dispatch(
        seq.build(
          "thinking-block",
          { messageId: seq.ids.message(), content: `reasoning ${index}` },
          undefined,
        ),
      );
      store.dispatch(
        seq.build(
          "assistant-message",
          { messageId: seq.ids.message(), text: `answer ${index}` },
          undefined,
        ),
      );
    }
    const ids = [...store.getState().byId.values()]
      .filter((item): item is ThinkingItem => item.kind === "thinking")
      .map((item) => item.id);
    expect(ids).toHaveLength(count);
    return { store, ids };
  }

  it("focuses a card when a click expands it and releases focus when it collapses", () => {
    const { store, ids } = storeWithThinking(1);
    const id = ids[0]!;

    store.toggleThinkingItem(id, false);
    expect(store.getState().focusedThinkingId).toBe(id);
    expect(isItemExpanded(store.getState(), store.getState().byId.get(id)!)).toBe(true);

    store.toggleThinkingItem(id, false);
    expect(store.getState().focusedThinkingId).toBeUndefined();
    expect(isItemExpanded(store.getState(), store.getState().byId.get(id)!)).toBe(false);
  });

  it("expands every card without focusing any when Ctrl+T is used", () => {
    const { store, ids } = storeWithThinking(2);

    store.focusThinking(ids[0]!);
    expect(store.getState().focusedThinkingId).toBe(ids[0]);

    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(true);
    expect(store.getState().focusedThinkingId).toBeUndefined();
  });

  it("keeps focus on the most recently clicked card only", () => {
    const { store, ids } = storeWithThinking(2);

    store.focusThinking(ids[0]!);
    store.focusThinking(ids[1]!);
    expect(store.getState().focusedThinkingId).toBe(ids[1]);

    store.blurThinking();
    expect(store.getState().focusedThinkingId).toBeUndefined();
  });
});
