import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRANSCRIPT_MOUNT_ROWS,
  DEFAULT_TRANSCRIPT_WINDOW_OVERLAP,
  resolveTranscriptMountWindow,
  shiftTranscriptWindowStart,
  TRANSCRIPT_PREFETCH_VIEWPORTS,
  transcriptPrefetchDirection,
  transcriptWindowStartForItem,
} from "../../../src/ui-core/state/transcript-window.js";

describe("transcript mount windows", () => {
  it("resolves an empty, short, and live-tail transcript", () => {
    expect(resolveTranscriptMountWindow(0, undefined)).toEqual({
      start: 0,
      end: 0,
      olderCount: 0,
      newerCount: 0,
    });
    expect(resolveTranscriptMountWindow(20, undefined)).toEqual({
      start: 0,
      end: 20,
      olderCount: 0,
      newerCount: 0,
    });
    expect(resolveTranscriptMountWindow(1_000, undefined)).toEqual({
      start: 1_000 - DEFAULT_TRANSCRIPT_MOUNT_ROWS,
      end: 1_000,
      olderCount: 1_000 - DEFAULT_TRANSCRIPT_MOUNT_ROWS,
      newerCount: 0,
    });
  });

  it("mounts at most the default window on a long transcript", () => {
    const window = resolveTranscriptMountWindow(1_000, undefined);
    expect(window.end - window.start).toBeLessThanOrEqual(
      DEFAULT_TRANSCRIPT_MOUNT_ROWS,
    );
    expect(window.newerCount).toBe(0);
  });

  it("clamps explicit windows and never mounts more than the configured size", () => {
    const starts = [-500, 0, 120, 999, 50_000];
    for (const requested of starts) {
      const window = resolveTranscriptMountWindow(1_000, requested, 125);
      expect(window.start).toBeGreaterThanOrEqual(0);
      expect(window.end).toBeLessThanOrEqual(1_000);
      expect(window.end - window.start).toBeLessThanOrEqual(125);
      expect(window.olderCount + (window.end - window.start) + window.newerCount).toBe(
        1_000,
      );
    }
    expect(resolveTranscriptMountWindow(1_000, -500, 125).start).toBe(0);
    expect(resolveTranscriptMountWindow(1_000, 50_000, 125).start).toBe(875);
  });

  it("pages in both directions while retaining the configured overlap", () => {
    const step =
      DEFAULT_TRANSCRIPT_MOUNT_ROWS - DEFAULT_TRANSCRIPT_WINDOW_OVERLAP;
    const tail = resolveTranscriptMountWindow(1_000, undefined).start;
    const older = shiftTranscriptWindowStart(1_000, tail, "older");
    expect(older).toBe(tail - step);
    expect(shiftTranscriptWindowStart(1_000, older, "newer")).toBe(tail);
    expect(shiftTranscriptWindowStart(1_000, 0, "older")).toBe(0);
    expect(shiftTranscriptWindowStart(1_000, tail, "newer")).toBe(tail);
  });

  it("centers search targets where possible and clamps both edges", () => {
    expect(transcriptWindowStartForItem(1_000, 0)).toBe(0);
    expect(transcriptWindowStartForItem(1_000, 500)).toBe(500 - DEFAULT_TRANSCRIPT_MOUNT_ROWS / 2);
    expect(transcriptWindowStartForItem(1_000, 999)).toBe(1_000 - DEFAULT_TRANSCRIPT_MOUNT_ROWS);
    expect(transcriptWindowStartForItem(20, 10)).toBe(0);
    expect(transcriptWindowStartForItem(0, 10)).toBe(0);
  });
});

describe("transcript window prefetch", () => {
  const base = { maxScrollTop: 1_000, viewportRows: 30, olderCount: 10, newerCount: 10 };
  const margin = 30 * TRANSCRIPT_PREFETCH_VIEWPORTS;

  it("mounts older items before an upward scroll reaches the mounted edge", () => {
    expect(transcriptPrefetchDirection({ ...base, scrollTop: margin, delta: -3 })).toBe("older");
    expect(transcriptPrefetchDirection({ ...base, scrollTop: margin + 1, delta: -3 })).toBeUndefined();
  });

  it("mounts newer items before a downward scroll reaches the mounted edge", () => {
    expect(transcriptPrefetchDirection({ ...base, scrollTop: 1_000 - margin, delta: 3 })).toBe("newer");
    expect(transcriptPrefetchDirection({ ...base, scrollTop: 1_000 - margin - 1, delta: 3 })).toBeUndefined();
  });

  it("only prefetches in the scroll direction and when items exist past the edge", () => {
    expect(transcriptPrefetchDirection({ ...base, scrollTop: 0, delta: 3 })).toBeUndefined();
    expect(transcriptPrefetchDirection({ ...base, scrollTop: 1_000, delta: -3 })).toBeUndefined();
    expect(transcriptPrefetchDirection({ ...base, olderCount: 0, scrollTop: 0, delta: -3 })).toBeUndefined();
    expect(transcriptPrefetchDirection({ ...base, newerCount: 0, scrollTop: 1_000, delta: 3 })).toBeUndefined();
    expect(transcriptPrefetchDirection({ ...base, scrollTop: 0, delta: 0 })).toBeUndefined();
  });
});
