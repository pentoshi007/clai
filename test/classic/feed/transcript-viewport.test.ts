import { describe, expect, it, vi } from "vitest";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { TranscriptViewport, type TranscriptViewportInput } from "../../../src/classic/feed/transcript-viewport.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";

function block(key: string, height: number): FeedBlock {
  return {
    key,
    itemId: key,
    kind: "assistant",
    open: false,
    rowCount: height,
    lines: Array.from({ length: height }, (_, index) => `${key}: ${index} 🙂`),
    turnId: undefined,
    sequence: 0,
  };
}

const input: TranscriptViewportInput = { columns: 80, generation: 0, navigationVersion: 0, offset: 492 };
const blocks = [block("a", 200), block("b", 200), block("c", 200), block("d", 200)];

function first(window: ReturnType<typeof planTranscriptWindow>): string | undefined {
  return window.rows[0]?.key;
}

describe("Classic anchored viewport", () => {
  it("preserves an item row across growth and shrink before and after it", () => {
    const viewport = new TranscriptViewport();
    const original = viewport.plan(blocks, 10, input);
    expect(first(original)).toBe("b:100");
    const smaller = [block("a", 2), blocks[1]!, block("c", 2), block("d", 2)];
    const shrunk = viewport.plan(smaller, 10, input);
    expect(first(shrunk)).toBe(first(original));
    expect(shrunk.offset).toBeLessThan(original.offset);
    for (let index = 0; index < 8; index += 1) {
      expect(first(viewport.plan(smaller, 10, input))).toBe(first(original));
    }
    const acknowledged = { ...input, offset: shrunk.offset };
    expect(first(viewport.plan(smaller, 10, acknowledged))).toBe(first(original));
    expect(first(viewport.plan(blocks, 10, acknowledged))).toBe(first(original));
  });

  it("honors a new navigation command even when its offset matches a pending old request", () => {
    const viewport = new TranscriptViewport();
    viewport.plan(blocks, 10, input);
    const changed = [blocks[0]!, blocks[1]!, block("c", 2), blocks[3]!];
    const corrected = viewport.plan(changed, 10, input);
    expect(corrected.offset).not.toBe(input.offset);
    const navigated = viewport.plan(changed, 10, { ...input, navigationVersion: 1 });
    expect(navigated).toEqual(planTranscriptWindow(changed, 10, input.offset));
    expect(first(navigated)).not.toBe(first(corrected));
  });

  it("follows new content at the bottom and resumes following after deliberate navigation", () => {
    const viewport = new TranscriptViewport();
    const bottom = { ...input, offset: 0 };
    expect(viewport.plan(blocks, 10, bottom).offset).toBe(0);
    const grown = [...blocks, block("e", 100)];
    expect(viewport.plan(grown, 10, bottom).rows.at(-1)?.line).toBe("e: 99 🙂");
    const paused = viewport.plan(grown, 10, { ...input, navigationVersion: 1 });
    expect(paused.offset).toBe(input.offset);
    expect(viewport.plan(blocks, 10, { ...bottom, navigationVersion: 2 }).offset).toBe(0);
    expect(viewport.plan(grown, 10, { ...bottom, navigationVersion: 2 }).rows.at(-1)?.line).toBe("e: 99 🙂");
  });

  it("retains a paused anchor when temporary shrink clamps its offset to zero", () => {
    const viewport = new TranscriptViewport();
    const original = viewport.plan([block("a", 100), block("b", 100)], 10, { ...input, offset: 20 });
    const smaller = [block("a", 100), block("b", 2)];
    const clamped = viewport.plan(smaller, 10, { ...input, offset: 20 });
    expect(clamped.offset).toBe(0);
    const restored = viewport.plan([block("a", 100), block("b", 100)], 10, { ...input, offset: 0 });
    expect(first(restored)).toBe(first(original));
    const bottom = { ...input, offset: 0, navigationVersion: 1 };
    expect(viewport.plan(smaller, 10, bottom).offset).toBe(0);
    expect(viewport.plan(blocks, 10, bottom).offset).toBe(0);
  });

  it("restores the intended row after an overlay releases and reloads its artifact", () => {
    const viewport = new TranscriptViewport();
    const original = viewport.plan(blocks, 10, input);
    expect(viewport.plan(blocks, 0, input).rows).toEqual([]);
    const unloaded = blocks.map((entry) => block(entry.key, 2));
    const hidden = viewport.plan(unloaded, 0, input);
    const reopened = viewport.plan(unloaded, 10, { ...input, offset: hidden.offset });
    expect(reopened.visibleItemIds.has("b")).toBe(true);
    const restored = viewport.plan(blocks, 10, { ...input, offset: reopened.offset });
    expect(first(restored)).toBe(first(original));
  });

  it.each([
    { ...input, generation: 1 },
    { ...input, columns: 40 },
    { ...input, navigationVersion: 1 },
  ])("does not restore a stale anchor across a reset or navigation: %j", (next) => {
    const viewport = new TranscriptViewport();
    viewport.plan(blocks, 10, input);
    const changed = [block("a", 2), blocks[1]!, blocks[2]!, blocks[3]!];
    expect(viewport.plan(changed, 10, next)).toEqual(planTranscriptWindow(changed, 10, next.offset));
  });

  it("falls back safely when its anchored item disappears or the transcript is empty", () => {
    const viewport = new TranscriptViewport();
    viewport.plan(blocks, 10, input);
    expect(viewport.plan([], 10, input).rows).toEqual([]);
    expect(viewport.plan([blocks[0]!], 10, input)).toEqual(planTranscriptWindow([blocks[0]!], 10, input.offset));
  });

  it("preserves gap anchors and adjusts the viewport budget without losing the first row", () => {
    const viewport = new TranscriptViewport();
    const gap = { ...input, offset: 593 };
    const original = viewport.plan(blocks, 10, gap);
    expect(first(original)).toBe("a:gap");
    const changed = [blocks[0]!, block("b", 2), block("c", 2), blocks[3]!];
    expect(first(viewport.plan(changed, 5, gap))).toBe(first(original));
    expect(first(viewport.plan(changed, 20, gap))).toBe(first(original));
  });

  it("does not hydrate offscreen layouts when resolving its anchor", () => {
    const read = vi.fn(() => ["line"]);
    const many = Array.from({ length: 5_000 }, (_, index) => ({
      ...block(String(index), 1),
      get lines() { return read(); },
    }));
    const viewport = new TranscriptViewport();
    viewport.plan(many, 10, input);
    read.mockClear();
    viewport.plan(many, 10, input);
    expect(read.mock.calls.length).toBeLessThan(20);
  });
});
