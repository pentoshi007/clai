import { describe, expect, it, vi } from "vitest";
import {
  asSessionId,
  asTurnId,
} from "../../src/app/events/app-event.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import { buildFeedBlocks, MAX_BLOCK_ROWS } from "../../src/classic/feed/feed-blocks.js";
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

  it("keeps 200 tool-output lines bounded in the classic feed", () => {
    const turn = scriptedTurn();
    const tool = transcriptItems(turn.state).find((item) => item.kind === "tool");
    expect(tool?.kind).toBe("tool");
    if (!tool || tool.kind !== "tool") return;
    turn.spool.replace(
      tool.toolCallId,
      Array.from({ length: 200 }, (_, index) => `output line ${index}`).join("\n"),
    );
    const state: TranscriptState = { ...turn.state, expandOutputGlobal: true };
    const block = buildFeedBlocks(state, feedView(turn, { columns: 80 })).find(
      (candidate) => candidate.itemId === tool.id,
    );

    expect(block).toBeDefined();
    expect(block!.lines.length).toBeLessThanOrEqual(MAX_BLOCK_ROWS);
    expect(block!.lines.length).toBeLessThan(200);
  });

  it("keeps pathological feed blocks within MAX_BLOCK_ROWS", () => {
    const turn = scriptedTurn();
    const item: TranscriptItem = {
      id: "classic-perf-huge",
      kind: "user",
      sequence: 1,
      turnId: undefined,
      timestamp: 0,
      text: Array.from({ length: MAX_BLOCK_ROWS + 200 }, (_, index) => `line ${index}`).join("\n"),
    };
    const state: TranscriptState = {
      ...EMPTY_TRANSCRIPT_STATE,
      order: [item.id],
      byId: new Map([[item.id, item]]),
    };
    const blocks = buildFeedBlocks(state, feedView(turn, { columns: 80 }));

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.lines.length).toBeLessThanOrEqual(MAX_BLOCK_ROWS);
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
