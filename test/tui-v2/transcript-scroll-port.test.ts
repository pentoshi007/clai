import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SCROLL_METRICS,
  publishTranscriptScrollMetrics,
  registerTranscriptJumpHandlers,
  registerTranscriptScrollPort,
  transcriptScrollPort,
} from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";

function stubFrames(syncWhenIdle: boolean) {
  const queued = new Map<number, () => void>();
  let idle = true;
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    const frame = ++id;
    if (syncWhenIdle && idle) {
      idle = false;
      callback();
      return frame;
    }
    queued.set(frame, callback);
    return frame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: number) => queued.delete(frame));
  return {
    get pending() {
      return queued.size;
    },
    flush() {
      for (const [frame, callback] of queued) {
        queued.delete(frame);
        callback();
      }
      idle = true;
    },
  };
}

describe("transcript scroll port", () => {
  afterEach(() => {
    transcriptScrollPort.stopWheel();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("delivers metrics only when they change", () => {
    const seen: Array<{ linesAbove: number; linesBelow: number }> = [];
    const stop = transcriptScrollPort.onMetrics((metrics) => {
      seen.push(metrics);
    });
    try {
      const initial = seen.length;
      publishTranscriptScrollMetrics({ linesAbove: 10, linesBelow: 4 });
      publishTranscriptScrollMetrics({ linesAbove: 10, linesBelow: 4 });
      publishTranscriptScrollMetrics({ linesAbove: 11, linesBelow: 4 });
      expect(seen.length).toBe(initial + 2);
      expect(seen.at(-1)).toEqual({ linesAbove: 11, linesBelow: 4 });
    } finally {
      stop();
    }
  });

  it("stops delivery after unsubscribe", () => {
    let calls = 0;
    const stop = transcriptScrollPort.onMetrics(() => {
      calls += 1;
    });
    const baseline = calls;
    stop();
    publishTranscriptScrollMetrics({ linesAbove: 99, linesBelow: 1 });
    expect(calls).toBe(baseline);
    publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
  });

  it("invokes scroll handlers synchronously on input", () => {
    expect(transcriptScrollPort.scrollBy(3)).toBe(false);
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => {
      calls.push(dy);
    });
    try {
      expect(transcriptScrollPort.scrollBy(3)).toBe(true);
      expect(calls).toEqual([3]);
      expect(transcriptScrollPort.scrollBy(0)).toBe(false);
      expect(calls).toEqual([3]);
    } finally {
      stop();
    }
    expect(transcriptScrollPort.scrollBy(3)).toBe(false);
  });

  it("publishes newer unmounted content even when the local window is at its bottom", () => {
    publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
    let calls = 0;
    const stop = transcriptScrollPort.onMetrics(() => { calls += 1; });
    try {
      publishTranscriptScrollMetrics({ linesAbove: 0, linesBelow: 0, hasNewerContent: true });
      expect(transcriptScrollPort.metrics.hasNewerContent).toBe(true);
      expect(calls).toBe(2);
      publishTranscriptScrollMetrics({ linesAbove: 0, linesBelow: 0, hasNewerContent: true });
      expect(calls).toBe(2);
      publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
      expect(transcriptScrollPort.metrics).toEqual(EMPTY_SCROLL_METRICS);
      expect(calls).toBe(3);
    } finally {
      stop();
      publishTranscriptScrollMetrics(EMPTY_SCROLL_METRICS);
    }
  });

  it("routes top and bottom jumps through registered handlers", () => {
    expect(transcriptScrollPort.scrollToTop()).toBe(false);
    expect(transcriptScrollPort.scrollToBottom()).toBe(false);
    let top = 0;
    let bottom = 0;
    const stop = registerTranscriptJumpHandlers(
      () => {
        top += 1;
      },
      () => {
        bottom += 1;
      },
    );
    try {
      expect(transcriptScrollPort.scrollToTop()).toBe(true);
      expect(transcriptScrollPort.scrollToBottom()).toBe(true);
      expect([top, bottom]).toEqual([1, 1]);
    } finally {
      stop();
    }
  });

  it("ignores wheel input without a handler or distance", () => {
    const frames = stubFrames(false);
    expect(transcriptScrollPort.wheel(1)).toBe(false);
    const stop = registerTranscriptScrollPort(vi.fn());
    try {
      expect(transcriptScrollPort.wheel(0)).toBe(false);
      expect(frames.pending).toBe(0);
    } finally {
      stop();
    }
  });

  it("glides queued notches without losing distance or scheduling duplicate frames", () => {
    const frames = stubFrames(false);
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      expect(transcriptScrollPort.wheel(-10)).toBe(true);
      expect(transcriptScrollPort.wheel(-10)).toBe(true);
      expect(calls).toEqual([]);
      expect(frames.pending).toBe(1);
      frames.flush();
      expect(calls.reduce((sum, dy) => sum + dy, 0)).toBe(-20);
      expect(calls.every(dy => dy === -1 || dy === -2)).toBe(true);
      expect(frames.pending).toBe(0);
    } finally {
      stop();
    }
  });

  it("keeps gliding after a frame callback runs synchronously on an idle renderer", () => {
    const frames = stubFrames(true);
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      transcriptScrollPort.wheel(1);
      frames.flush();
      transcriptScrollPort.wheel(1);
      expect(frames.pending).toBe(0);
      transcriptScrollPort.wheel(1);
      frames.flush();
      expect(calls).toEqual([1, 1, 1]);
      expect(calls.every((dy) => dy === 1)).toBe(true);
      expect(frames.pending).toBe(0);
    } finally {
      stop();
    }
  });

  it("cancels a pending glide when scrolled directly", () => {
    const frames = stubFrames(false);
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      transcriptScrollPort.wheel(-10);
      transcriptScrollPort.scrollBy(5);
      expect(frames.pending).toBe(0);
      frames.flush();
      expect(calls).toEqual([5]);
      transcriptScrollPort.wheel(1);
      frames.flush();
      expect(calls).toEqual([5, 1]);
    } finally {
      stop();
    }
  });
});
