import { describe, expect, it, vi } from "vitest";
import {
  asSessionId,
  asTurnId,
} from "../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import { buildFeedBlocks, FeedBlockCache } from "../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../src/classic/feed/transcript-window.js";
import { feedView, scriptedTurn } from "./feed/fixture.js";
import { extractTranscriptSemanticDocument } from "../../src/ui-core/rendering/transcript-semantic.js";
import { TranscriptStore } from "../../src/ui-core/state/transcript-store.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  transcriptItems,
  type TranscriptItem,
  type TranscriptState,
} from "../../src/ui-core/state/transcript-types.js";

const ASSISTANT_DELTAS = 8_000;
const SEMANTIC_ITEMS = 10_000;
const SEMANTIC_BUDGET_MS = 2_000;

function sequencer(): EventSequencer {
  return new EventSequencer(
    asSessionId("classic-perf"),
    createCountingIdFactory("classic-perf-"),
    { now: () => 1_700_000_000_000 },
  );
}

describe("classic performance safeguards", () => {
  it(`coalesces ${ASSISTANT_DELTAS} assistant deltas to one store notification`, () => {
    vi.useFakeTimers();
    try {
      const store = new TranscriptStore();
      const seq = sequencer();
      const turnId = asTurnId("classic-perf-turn");
      let notifications = 0;
      store.subscribe(() => {
        notifications += 1;
      });

      for (let i = 0; i < ASSISTANT_DELTAS; i += 1) {
        store.dispatch(seq.build("assistant-delta", { text: "delta" }, turnId));
      }

      expect(notifications).toBe(0);
      expect(store.getState().order).toHaveLength(1);
      vi.advanceTimersByTime(16);
      expect(notifications).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders every row of a pathological block without truncation", () => {
    const turn = scriptedTurn();
    const rows = 5_000;
    const item: TranscriptItem = {
      id: "classic-perf-huge",
      kind: "assistant",
      streaming: false,
      sequence: 1,
      turnId: undefined,
      timestamp: 0,
      text: Array.from({ length: rows }, (_, index) => `line ${index}`).join("\n"),
    };
    const state: TranscriptState = {
      ...EMPTY_TRANSCRIPT_STATE,
      order: [item.id],
      byId: new Map([[item.id, item]]),
    };
    const blocks = buildFeedBlocks(state, feedView(turn, { columns: 80 }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines.length).toBeGreaterThanOrEqual(rows);
    expect(blocks[0]!.lines.some((line) => line.includes(`line ${rows - 1}`))).toBe(true);
  });

  it("reuses unchanged blocks and only rebuilds the changed item", () => {
    const turn = scriptedTurn();
    const cache = new FeedBlockCache();
    const view = feedView(turn, { columns: 80 });
    const first = buildFeedBlocks(turn.state, view, cache);
    const again = buildFeedBlocks(turn.state, { ...view, now: view.now + 60_000 }, cache);
    const closed = first.filter((block) => !block.open);
    expect(closed.length).toBeGreaterThan(0);
    for (const block of closed) {
      expect(again.find((candidate) => candidate.itemId === block.itemId)).toBe(block);
    }
  });

  it("does not read old tool artifacts on each render after caching their rows", () => {
    const turn = scriptedTurn();
    const cache = new FeedBlockCache();
    const view = feedView(turn, { columns: 80 });
    const read = vi.spyOn(turn.spool, "tail");
    const first = buildFeedBlocks(turn.state, view, cache);
    read.mockClear();
    const again = buildFeedBlocks(turn.state, view, cache);
    expect(read).not.toHaveBeenCalled();
    expect(again).toEqual(first);
    read.mockRestore();
  });

  it("plans a viewport over a very long feed without materialising every row", () => {
    const blocks = Array.from({ length: 5_000 }, (_, index) => ({
      key: `0:item-${index}`,
      itemId: `item-${index}`,
      kind: "assistant" as const,
      open: false,
      lines: Array.from({ length: 40 }, (_, line) => `row ${index}.${line}`),
      turnId: undefined,
      sequence: index,
    }));
    const started = performance.now();
    const window = planTranscriptWindow(blocks, 40, 100_000);
    expect(performance.now() - started).toBeLessThan(200);
    expect(window.rows).toHaveLength(40);
    expect(window.totalRows).toBe(5_000 * 41 - 1);
  });

  it(`folds a ${SEMANTIC_ITEMS}-item semantic transcript within a generous budget`, () => {
    const order: string[] = [];
    const byId = new Map<string, TranscriptItem>();
    for (let i = 0; i < SEMANTIC_ITEMS; i += 1) {
      const id = `classic-user-${i}`;
      order.push(id);
      byId.set(id, {
        id,
        sequence: i + 1,
        turnId: undefined,
        timestamp: i + 1,
        kind: "user",
        text: `prompt ${i}`,
      });
    }
    const state: TranscriptState = {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      lastSequence: SEMANTIC_ITEMS,
    };
    const started = performance.now();
    const document = extractTranscriptSemanticDocument(state, { thinking: "none" });

    expect(document.blocks).toHaveLength(SEMANTIC_ITEMS);
    expect(performance.now() - started).toBeLessThan(SEMANTIC_BUDGET_MS);
  });
});
