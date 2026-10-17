import { describe, expect, it } from "vitest";
import { buildFeedBlocks, FeedBlockCache, type FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow, totalTranscriptRows } from "../../../src/classic/feed/transcript-window.js";
import { classicTranscriptDocument } from "../../../src/classic/feed/transcript-selection.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { normalizeSemanticDocument, semanticRangeText } from "../../../src/ui-core/state/semantic-document.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem, type TranscriptState } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "./fixture.js";

function history(count = 12): TranscriptState {
  const items: AssistantItem[] = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, kind: "assistant", streaming: false, sequence: index,
    timestamp: 0, turnId: undefined,
    text: Array.from({ length: 20 }, (_, row) => `message ${index} row ${row} 日本語 🧪 **complete**`).join("\n"),
  }));
  return { ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) };
}

function plain(block: FeedBlock): string {
  return block.lines.map(stripAnsi).join("\n");
}

describe("Classic lossless render budgets", () => {
  it("evicts layouts without losing rows, identities or first-to-last navigation", () => {
    const state = history();
    const cache = new FeedBlockCache(4096);
    const view = feedView(scriptedTurn(), { columns: 80 });
    const blocks = buildFeedBlocks(state, view, cache);
    const total = totalTranscriptRows(blocks);
    expect(cache.retainedLayoutBytes).toBeLessThanOrEqual(4096);
    for (const index of [0, 5, 11, 0, 11]) {
      const block = blocks[index]!;
      expect(plain(block)).toContain(`message ${index} row 19 日本語 🧪 complete`);
      expect(block.lines.length).toBe(block.rowCount);
      expect(cache.retainedLayoutBytes).toBeLessThanOrEqual(4096);
    }
    expect(totalTranscriptRows(blocks)).toBe(total);
    const first = planTranscriptWindow(blocks, 10, total);
    const last = planTranscriptWindow(blocks, 10, 0);
    expect(first.firstItemId).toBe("message-0");
    expect(last.lastItemId).toBe("message-11");
    const again = buildFeedBlocks(state, view, cache);
    blocks.forEach((block, index) => expect(again[index]).toBe(block));
  });

  it("indexes and normalizes history without reading off-screen layouts", () => {
    const reads = new Map<number, number>();
    const blocks: FeedBlock[] = Array.from({ length: 5000 }, (_, index) => ({
      key: `0:${index}`, itemId: String(index), kind: "assistant", open: false,
      rowCount: 40, turnId: undefined, sequence: index,
      get lines() {
        reads.set(index, (reads.get(index) ?? 0) + 1);
        return Array.from({ length: 40 }, (_, row) => `message ${index} row ${row}`);
      },
    }));
    const document = normalizeSemanticDocument(classicTranscriptDocument(blocks));
    expect(reads.size).toBe(0);
    expect(totalTranscriptRows(blocks)).toBe(5000 * 41 - 1);
    const last = planTranscriptWindow(blocks, 20, 0);
    expect(last.rows).toHaveLength(20);
    expect([...reads.keys()]).toEqual([4999]);
    expect(document.blocks[0]!.text).toContain("message 0 row 39");
    expect([...reads.keys()]).toEqual([4999, 0]);
  });

  it("selects complete text across evicted layouts including Unicode", () => {
    const blocks = buildFeedBlocks(history(3), feedView(scriptedTurn(), { columns: 80 }), new FeedBlockCache(512));
    const document = normalizeSemanticDocument(classicTranscriptDocument(blocks));
    const text = semanticRangeText(document, {
      anchor: { blockId: blocks[0]!.key, offset: 0 },
      focus: { blockId: blocks[2]!.key, offset: Number.MAX_SAFE_INTEGER },
    });
    for (let index = 0; index < 3; index += 1) {
      for (let row = 0; row < 20; row += 1) expect(text).toContain(`message ${index} row ${row} 日本語 🧪 complete`);
    }
  });

  it("rebuilds exact rows on resize, theme and expansion changes after eviction", () => {
    const turn = scriptedTurn();
    const cache = new FeedBlockCache(512);
    for (const columns of [40, 120, 80]) {
      for (const colorMode of ["truecolor", "none"] as const) {
        for (const expanded of [false, true]) {
          const view = feedView(turn, { columns, colorMode });
          const state = { ...turn.state, expandOutputGlobal: expanded, expandThinkingGlobal: expanded };
          const cached = buildFeedBlocks(state, view, cache);
          const fresh = buildFeedBlocks(state, view);
          expect(cached.map((block) => block.lines)).toEqual(fresh.map((block) => block.lines));
          expect(cached.map((block) => block.rowCount)).toEqual(fresh.map((block) => block.lines.length));
          expect(cache.retainedLayoutBytes).toBeLessThanOrEqual(512);
        }
      }
    }
  });
});

it("releases retained layouts when a session feed resets", () => {
  const cache = new FeedBlockCache(4096);
  const view = feedView(scriptedTurn(), { columns: 80 });
  buildFeedBlocks(history(3), view, cache);
  expect(cache.retainedLayoutBytes).toBeGreaterThan(0);
  buildFeedBlocks(EMPTY_TRANSCRIPT_STATE, view, cache);
  expect(cache.retainedLayoutBytes).toBe(0);
});

it("releases superseded collapsed streaming inputs instead of retaining their large source text", () => {
  const cache = new FeedBlockCache(1024 * 1024);
  const view = feedView(scriptedTurn(), { columns: 80 });
  const base = { id: "thinking", kind: "thinking" as const, streaming: true, sequence: 1, timestamp: 0, turnId: undefined };
  let previous: FeedBlock | undefined;
  let initialWeight = 0;
  for (let index = 0; index < 100; index += 1) {
    const item = { ...base, content: `${index.toString().padStart(3, "0")}${"complete 日本語 🧪".repeat(8000)}` };
    const state = { ...EMPTY_TRANSCRIPT_STATE, order: [item.id], byId: new Map([[item.id, item]]) };
    const blocks = buildFeedBlocks(state, view, cache);
    if (index === 0) { initialWeight = cache.retainedLayoutBytes; previous = blocks[0]; }
    expect(cache.retainedLayoutBytes).toBe(initialWeight);
  }
  const before = cache.retainedLayoutBytes;
  expect(previous!.lines.join("\n")).toContain("Thinking");
  expect(cache.retainedLayoutBytes).toBe(before);
});

it("releases layouts for removed items while retaining the remaining feed", () => {
  const cache = new FeedBlockCache(1024 * 1024);
  const view = feedView(scriptedTurn(), { columns: 80 });
  const state = history(3);
  buildFeedBlocks(state, view, cache);
  const next = { ...state, order: state.order.slice(-1), byId: new Map([[state.order.at(-1)!, state.byId.get(state.order.at(-1)!)!]]) };
  const retained = buildFeedBlocks(next, view, cache);
  const fresh = new FeedBlockCache(1024 * 1024);
  buildFeedBlocks(next, view, fresh);
  expect(cache.retainedLayoutBytes).toBe(fresh.retainedLayoutBytes);
  expect(plain(retained[0]!)).toContain("message 2 row 19");
});
