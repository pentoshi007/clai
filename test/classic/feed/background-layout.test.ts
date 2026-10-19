import { createElement, useEffect, useSyncExternalStore } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useFeed, type FeedSnapshot } from "../../../src/classic/app/use-feed.js";
import { BackgroundLayout } from "../../../src/classic/feed/background-layout.js";
import { buildFeedBlocks, FeedBlockCache } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem } from "../../../src/ui-core/state/transcript-types.js";
import { createHarness, type Harness } from "../app/harness.js";

function transcript(count: number) {
  const items: AssistantItem[] = Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`, kind: "assistant", sequence: index, timestamp: 0, turnId: undefined, streaming: false,
    text: Array.from({ length: 12 }, (_, line) => `MESSAGE_${index}_LINE_${line} with **bold** prose that wraps across narrow terminals`).join("\n"),
  }));
  return { ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) };
}

function blocksFor(count: number, columns = 80) {
  const cache = new FeedBlockCache();
  const ink = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
  return { cache, blocks: buildFeedBlocks(transcript(count), { columns, ink, now: 0, generation: 0, deferLayout: true }, cache) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("background transcript layout", () => {
  it("measures pending blocks newest first in bounded slices without retaining layouts", () => {
    const { blocks, cache } = blocksFor(200);
    planTranscriptWindow(blocks, 20, 0);
    let clock = 0;
    const order: string[] = [];
    for (const block of blocks) {
      const measure = block.measure!;
      Object.defineProperty(block, "measure", { value: () => { clock += 1; order.push(block.itemId); return measure(); } });
    }
    const pending = blocks.filter((block) => block.layoutPending).map((block) => block.itemId);
    expect(pending.length).toBeGreaterThan(150);
    const settled = vi.fn();
    const layout = new BackgroundLayout({ sliceMs: 10, now: () => clock });
    layout.schedule(blocks, settled);
    expect(layout.pending).toBe(true);
    expect(layout.step()).toBe(false);
    expect(order).toHaveLength(10);
    while (!layout.step()) expect(settled).not.toHaveBeenCalled();
    expect(settled).toHaveBeenCalledTimes(1);
    expect(blocks.every((block) => !block.layoutPending)).toBe(true);
    expect(order).toEqual([...pending].reverse());
    expect(cache.retainedLayoutBytes).toBeLessThan(64 * 1024);
    layout.schedule(blocks, settled);
    expect(layout.pending).toBe(false);
    const top = planTranscriptWindow(blocks, 20, Number.MAX_SAFE_INTEGER);
    expect(top.firstItemId).toBe("message-0");
    expect(top.rows[0]?.lineIndex).toBe(0);
    expect(top.layoutPending).toBe(false);
  });

  it("waits for a quiet period, restarts on new blocks and stops when disposed", () => {
    vi.useFakeTimers();
    const first = blocksFor(40).blocks;
    const second = blocksFor(40, 60).blocks;
    const settled = vi.fn();
    const layout = new BackgroundLayout({ startDelayMs: 100, sliceMs: 1_000 });
    layout.schedule(first, settled);
    vi.advanceTimersByTime(90);
    layout.schedule(second, settled);
    vi.advanceTimersByTime(90);
    expect(second.every((block) => block.layoutPending)).toBe(true);
    vi.advanceTimersByTime(20);
    expect(second.every((block) => !block.layoutPending)).toBe(true);
    expect(first.some((block) => block.layoutPending)).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    const third = blocksFor(40, 50).blocks;
    layout.schedule(third, settled);
    layout.dispose();
    vi.advanceTimersByTime(1_000);
    expect(third.every((block) => block.layoutPending)).toBe(true);
  });
});

describe("classic feed background layout", () => {
  let harness: Harness | undefined;
  let ui: ReturnType<typeof render> | undefined;
  let latest: FeedSnapshot | undefined;

  afterEach(() => {
    ui?.unmount();
    harness?.dispose();
    harness = undefined;
    ui = undefined;
    latest = undefined;
  });

  function Probe() {
    const snapshot = useSyncExternalStore(harness!.wiring.subscribe, harness!.wiring.getSnapshot);
    const feed = useFeed({
      services: harness!.services,
      state: snapshot.transcript,
      columns: 80,
      liveBudgetRows: 12,
      now: snapshot.feedNow,
      generation: snapshot.feedGeneration,
      liveOffset: snapshot.liveOffset,
      navigationVersion: snapshot.feedNavigationVersion,
      intro: undefined,
    });
    latest = feed;
    useEffect(() => harness!.wiring.observeFeed(feed), [feed]);
    return createElement(Text, {}, feed.window.rows.map((row) => row.line).join("\n"));
  }

  it("settles every height while idle so the first jump to the top is already measured", async () => {
    harness = createHarness({ columns: 80 });
    harness.services.transcript.hydrate(transcript(300));
    ui = render(createElement(Probe));
    await vi.waitFor(() => expect(latest?.window.lastItemId).toBe("message-299"));
    expect(latest!.window.layoutPending).toBe(true);
    await vi.waitFor(() => expect(latest!.window.layoutPending).toBe(false), { timeout: 20_000 });
    expect(harness.wiring.maxLiveOffset).toBe(latest!.window.maxOffset);
    expect(latest!.window.offset).toBe(0);
    expect(latest!.window.lastItemId).toBe("message-299");
    harness.wiring.scrollFeed(Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() => {
      expect(latest!.window.firstItemId).toBe("message-0");
      expect(latest!.window.rows[0]!.lineIndex).toBe(0);
      expect(harness!.wiring.liveOffsetValue).toBe(latest!.window.maxOffset);
    });
    expect(latest!.blocks.every((block) => !block.layoutPending)).toBe(true);
  });
});
