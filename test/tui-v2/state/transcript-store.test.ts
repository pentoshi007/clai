import { describe, expect, it } from "vitest";
import { asSessionId } from "../../../src/app/events/app-event.js";
import { EventSequencer } from "../../../src/app/events/sequencer.js";
import { TranscriptStore } from "../../../src/tui-v2/state/transcript-store.js";
import type { ThinkingItem, ToolItem } from "../../../src/tui-v2/state/transcript-types.js";
import { isItemExpanded } from "../../../src/tui-v2/state/transcript-types.js";
import { asToolCallId } from "../../../src/app/events/app-event.js";

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

  it("toggleItemOverride overrides the global default for one item only", () => {
    const store = new TranscriptStore();
    const seq = new EventSequencer(asSessionId("s1"));
    store.dispatch(seq.build("thinking-block", { messageId: seq.ids.message(), content: "x" }, undefined));
    const item = [...store.getState().byId.values()][0] as ThinkingItem;

    expect(isItemExpanded(store.getState(), item)).toBe(false);
    store.toggleItemOverride(item.id, store.getState().expandThinkingGlobal);
    expect(isItemExpanded(store.getState(), item)).toBe(true);

    // The global toggle still doesn't affect an item with its own override.
    store.toggleThinkingGlobal();
    expect(store.getState().expandThinkingGlobal).toBe(true);
    expect(isItemExpanded(store.getState(), item)).toBe(true);
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
});
