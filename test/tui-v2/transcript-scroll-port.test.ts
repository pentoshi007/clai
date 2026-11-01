import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_SCROLL_METRICS,
  publishTranscriptScrollMetrics,
  registerTranscriptJumpHandlers,
  registerTranscriptScrollPort,
  transcriptScrollPort,
} from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";
import { WHEEL_FRAME_MS } from "../../src/ui-core/motion/wheel-scroll.js";

function stubFrames() {
  const requestFrame = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return requestFrame;
}

function deliverInput(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function stubWheelScheduler() {
  const callbacks = new Set<(deltaTime: number) => Promise<void>>();
  let now = performance.now();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  return {
    callbacks,
    requestRender: vi.fn(),
    setFrameCallback: (callback: (deltaTime: number) => Promise<void>) => { callbacks.add(callback); },
    removeFrameCallback: (callback: (deltaTime: number) => Promise<void>) => { callbacks.delete(callback); },
    async paint(): Promise<void> {
      now += WHEEL_FRAME_MS;
      for (const callback of callbacks) await callback(WHEEL_FRAME_MS);
    },
  };
}

async function paintUntilIdle(scheduler: ReturnType<typeof stubWheelScheduler>, scroll: { mock: { calls: unknown[][] } }): Promise<number[]> {
  const steps: number[] = [];
  for (let frame = 0; frame < 200; frame += 1) {
    const before = scroll.mock.calls.length;
    await scheduler.paint();
    if (scroll.mock.calls.length === before) break;
    steps.push(scroll.mock.calls.at(-1)![0] as number);
  }
  return steps;
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

  it("ignores wheel input without a handler or distance", async () => {
    expect(transcriptScrollPort.wheel(1)).toBe(false);
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll);
    try {
      for (const invalid of [0, NaN, Infinity, -Infinity]) {
        expect(transcriptScrollPort.wheel(invalid)).toBe(false);
      }
      await deliverInput();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("applies every notch of one input chunk as a single scroll without animation frames", async () => {
    const requestFrame = stubFrames();
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      for (let notch = 0; notch < 120; notch += 1) expect(transcriptScrollPort.wheel(-1)).toBe(true);
      expect(calls).toEqual([]);
      await deliverInput();
      expect(calls).toEqual([-120]);
      expect(requestFrame).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it("moves each separately delivered notch exactly once", async () => {
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      for (let notch = 0; notch < 3; notch += 1) {
        transcriptScrollPort.wheel(1);
        await deliverInput();
      }
      expect(calls).toEqual([1, 1, 1]);
      await deliverInput();
      expect(calls).toEqual([1, 1, 1]);
    } finally {
      stop();
    }
  });

  it("glides separate SSH input chunks across renderer frames without losing distance", async () => {
    const scheduler = stubWheelScheduler();
    const { callbacks } = scheduler;
    const scroll = vi.fn(() => true);
    const stop = registerTranscriptScrollPort(scroll, scheduler);
    try {
      for (let chunk = 0; chunk < 40; chunk += 1) {
        transcriptScrollPort.wheel(-3);
        await deliverInput();
      }
      expect(scroll).not.toHaveBeenCalled();
      expect(scheduler.requestRender).toHaveBeenCalled();
      const requested = scheduler.requestRender.mock.calls.length;
      const steps = await paintUntilIdle(scheduler, scroll);
      expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-120);
      expect(steps.length).toBeGreaterThan(1);
      expect(Math.abs(steps[0]!)).toBeLessThan(120);
      for (let index = 1; index < steps.length; index += 1) {
        expect(Math.abs(steps[index]!)).toBeLessThanOrEqual(Math.abs(steps[index - 1]!));
      }
      expect(scheduler.requestRender.mock.calls.length - requested).toBe(steps.length - 1);
      transcriptScrollPort.wheel(1);
      await scheduler.paint();
      expect(scroll).toHaveBeenLastCalledWith(1);
    } finally {
      stop();
    }
    expect(callbacks.size).toBe(0);
  });

  it("ends the glide as soon as the transcript cannot move further", async () => {
    const scheduler = stubWheelScheduler();
    const scroll = vi.fn(() => false);
    const stop = registerTranscriptScrollPort(scroll, scheduler);
    try {
      transcriptScrollPort.wheel(-60);
      await scheduler.paint();
      await scheduler.paint();
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scheduler.requestRender).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it.each([false, true])("discards orphaned input before a later mount with reused scheduler %s", async (reuse) => {
    const scheduler = stubWheelScheduler();
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll, scheduler);
    transcriptScrollPort.wheel(120);
    stop();
    await deliverInput();
    const nextScheduler = reuse ? scheduler : stubWheelScheduler();
    const next = vi.fn();
    const stopNext = registerTranscriptScrollPort(next, nextScheduler);
    try {
      await nextScheduler.paint();
      expect(scroll).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      transcriptScrollPort.wheel(-1);
      await nextScheduler.paint();
      expect(next).toHaveBeenCalledExactlyOnceWith(-1);
    } finally {
      stopNext();
    }
  });

  it("preserves frame-owned input through a synchronous handler replacement", async () => {
    const scheduler = stubWheelScheduler();
    const first = vi.fn(() => true);
    const next = vi.fn(() => true);
    const stopFirst = registerTranscriptScrollPort(first, scheduler);
    transcriptScrollPort.wheel(-20);
    stopFirst();
    const stopNext = registerTranscriptScrollPort(next, scheduler);
    try {
      await deliverInput();
      const steps = await paintUntilIdle(scheduler, next);
      expect(first).not.toHaveBeenCalled();
      expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-20);
      expect(scheduler.callbacks.size).toBe(1);
    } finally {
      stopNext();
    }
  });

  it("drops the unfinished glide when the wheel reverses", async () => {
    const scheduler = stubWheelScheduler();
    const scroll = vi.fn(() => true);
    const stop = registerTranscriptScrollPort(scroll, scheduler);
    try {
      transcriptScrollPort.wheel(-30);
      await scheduler.paint();
      const travelled = scroll.mock.calls.reduce((sum, [rows]) => sum + (rows as number), 0);
      expect(travelled).toBeLessThan(0);
      transcriptScrollPort.wheel(1);
      const steps = await paintUntilIdle(scheduler, scroll);
      expect(steps).toEqual([1]);
    } finally {
      stop();
    }
  });

  it("applies a reversal inside one unscheduled input chunk in the newest direction", async () => {
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => { calls.push(dy); });
    try {
      transcriptScrollPort.wheel(-3);
      transcriptScrollPort.wheel(1);
      await deliverInput();
      expect(calls).toEqual([1]);
    } finally {
      stop();
    }
  });

  it.each(["scrollToTop", "scrollToBottom"] as const)("discards pending wheel input before %s", async (jump) => {
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll);
    const stopJumps = registerTranscriptJumpHandlers(vi.fn(), vi.fn());
    try {
      transcriptScrollPort.wheel(120);
      expect(transcriptScrollPort[jump]()).toBe(true);
      await deliverInput();
      expect(scroll).not.toHaveBeenCalled();
    } finally {
      stopJumps();
      stop();
    }
  });

  it("delivers pending input to the handler that is current when it is applied", async () => {
    const first = vi.fn();
    const next = vi.fn();
    const stopFirst = registerTranscriptScrollPort(first);
    transcriptScrollPort.wheel(20);
    stopFirst();
    const stopNext = registerTranscriptScrollPort(next);
    try {
      await deliverInput();
      expect(first).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalledExactlyOnceWith(20);
    } finally {
      stopNext();
    }
  });

  it("stops work if the mounted transcript disappears", async () => {
    const scroll = vi.fn();
    const stop = registerTranscriptScrollPort(scroll);
    transcriptScrollPort.wheel(120);
    stop();
    await deliverInput();
    expect(scroll).not.toHaveBeenCalled();
    const next = vi.fn();
    const stopNext = registerTranscriptScrollPort(next);
    try {
      await deliverInput();
      expect(next).not.toHaveBeenCalled();
    } finally {
      stopNext();
    }
  });

  it("discards pending wheel input when scrolled directly", async () => {
    const calls: number[] = [];
    const stop = registerTranscriptScrollPort((dy) => calls.push(dy));
    try {
      transcriptScrollPort.wheel(-10);
      transcriptScrollPort.scrollBy(5);
      expect(calls).toEqual([5]);
      await deliverInput();
      expect(calls).toEqual([5]);
      transcriptScrollPort.wheel(1);
      await deliverInput();
      expect(calls).toEqual([5, 1]);
    } finally {
      stop();
    }
  });
});
