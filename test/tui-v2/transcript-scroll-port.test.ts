import { describe, expect, it } from "vitest";
import {
  EMPTY_SCROLL_METRICS,
  publishTranscriptScrollMetrics,
  registerTranscriptJumpHandlers,
  registerTranscriptScrollPort,
  transcriptScrollPort,
} from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";

describe("transcript scroll port", () => {
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
});
