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
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
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
  function flushFrame(elapsed = 17): void {
    now += elapsed;
    const callbacks = [...queued.values()];
    queued.clear();
    for (const callback of callbacks) callback();
  }
  return {
    get pending() {
      return queued.size;
    },
    flushFrame,
    flush() {
      while (queued.size > 0) flushFrame();
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
      for (const invalid of [0, NaN, Infinity, -Infinity]) {
        expect(transcriptScrollPort.wheel(invalid)).toBe(false);
      }
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
      frames.flushFrame();
      expect(calls).toEqual([-7]);
      expect(frames.pending).toBe(1);
      frames.flushFrame();
      frames.flushFrame();
      expect(calls).toEqual([-7, -7, -6]);
      expect(calls.reduce((sum, dy) => sum + dy, 0)).toBe(-20);
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

  it("catches up on a delayed renderer frame without more trailing work", () => {
    const frames = stubFrames(false);
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      transcriptScrollPort.wheel(120);
      frames.flushFrame(100);
      expect(calls).toEqual([120]);
      expect(frames.pending).toBe(0);
    } finally {
      stop();
    }
  });

  it.each(["scrollToTop", "scrollToBottom"] as const)("cancels a glide before %s", (jump) => {
    const frames = stubFrames(false);
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll);
    const stopJumps = registerTranscriptJumpHandlers(vi.fn(), vi.fn());
    try {
      transcriptScrollPort.wheel(120);
      expect(transcriptScrollPort[jump]()).toBe(true);
      expect(frames.pending).toBe(0);
      frames.flush();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      stopJumps();
      stop();
    }
  });

  it("keeps pending input across mount-window handler replacement", () => {
    const frames = stubFrames(false);
    const first = vi.fn();
    const next = vi.fn();
    const stopFirst = registerTranscriptScrollPort(first);
    transcriptScrollPort.wheel(20);
    frames.flushFrame();
    stopFirst();
    const stopNext = registerTranscriptScrollPort(next);
    try {
      frames.flush();
      expect(first).toHaveBeenCalledExactlyOnceWith(7);
      expect(next.mock.calls.map(([rows]) => rows)).toEqual([7, 6]);
      expect(frames.pending).toBe(0);
    } finally {
      stopNext();
    }
  });

  it("stops work if the mounted transcript disappears", () => {
    const frames = stubFrames(false);
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll);
    transcriptScrollPort.wheel(120);
    stop();
    frames.flushFrame();
    expect(scroll).not.toHaveBeenCalled();
    expect(frames.pending).toBe(0);
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
