import { describe, expect, it } from "vitest";
import { buildFeedBlocks, FeedBlockCache } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import { classicTranscriptDocument } from "../../../src/classic/feed/transcript-selection.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem } from "../../../src/ui-core/state/transcript-types.js";

function fixture(count: number) {
  const items: AssistantItem[] = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, kind: "assistant", sequence: index, timestamp: 0, turnId: undefined, streaming: false,
    text: Array.from({ length: 100 }, (_, line) => `MESSAGE_${index}_LINE_${line} **retained** 日本語 🧪`).join("\n"),
  }));
  const state = { ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) };
  const cache = new FeedBlockCache();
  const view = { columns: 100, ink: createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true }), now: 0, generation: 0, deferLayout: true };
  return { items, state, cache, view };
}

describe("viewport-driven classic layout", () => {
  it("loads 1000 complete messages without eagerly laying them out", () => {
    const { state, view, cache } = fixture(1000);
    const blocks = buildFeedBlocks(state, view, cache);
    expect(blocks).toHaveLength(1000);
    expect(cache.retainedLayoutBytes).toBe(0);
    expect(classicTranscriptDocument(blocks).blocks).toHaveLength(1000);
    const tail = planTranscriptWindow(blocks, 30, 0);
    expect(tail.lastItemId).toBe("message-999");
    expect(tail.rows).toHaveLength(30);
    expect(blocks.filter((block) => !block.layoutPending).length).toBeLessThan(5);
    const first = planTranscriptWindow(blocks, 30, Number.MAX_SAFE_INTEGER);
    expect(first.firstItemId).toBe("message-0");
    expect(first.rows[0]?.lineIndex).toBe(0);
    expect(cache.retainedLayoutBytes).toBeLessThan(512 * 1024);
  });

  it("retains every line through scrolling, width changes and cache eviction", () => {
    const { state, view } = fixture(80);
    const cache = new FeedBlockCache(16 * 1024);
    for (const columns of [100, 45]) {
      const blocks = buildFeedBlocks(state, { ...view, columns }, cache);
      for (let index = 0; index < blocks.length; index++) {
        const lines = blocks[index]!.lines.join("\n");
        expect(lines).toContain(`MESSAGE_${index}_LINE_0`);
        expect(lines).toContain(`MESSAGE_${index}_LINE_99`);
      }
      expect(planTranscriptWindow(blocks, 10, Number.MAX_SAFE_INTEGER).firstItemId).toBe("message-0");
      expect(planTranscriptWindow(blocks, 10, 0).lastItemId).toBe("message-79");
      expect(cache.retainedLayoutBytes).toBeLessThanOrEqual(16 * 1024);
    }
  });
});
