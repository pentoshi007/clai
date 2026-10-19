import { afterEach, describe, expect, it, vi } from "vitest";
import { INITIAL_PAINT_PACING, PAINT_MIN_INTERVAL_MS } from "../../../src/classic/app/paint-pacing.js";
import { createHarness, type Harness } from "./harness.js";
import { CARET_BLINK_IDLE_MS } from "../../../src/classic/app/wiring-interactions.js";

vi.mock("../../../src/classic/app/git-branch.js", () => ({
  readBranchFromGitDir: async () => "test-branch",
}));

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  vi.useRealTimers();
});

async function setup(): Promise<Harness> {
  vi.useFakeTimers();
  harness = createHarness();
  harness.services.focus.focusRegion("transcript");
  await vi.advanceTimersByTimeAsync(100);
  harness.wiring.lastPaintAt = Date.now();
  harness.wiring.paintPacing = INITIAL_PAINT_PACING;
  return harness;
}

describe("classic paint scheduling", () => {
  it("coalesces a scroll burst without dropping any movement", async () => {
    const { wiring } = await setup();
    wiring.maxLiveOffset = 100_000;
    const listener = vi.fn();
    wiring.subscribe(listener);
    for (let index = 0; index < 200; index += 1) wiring.scrollFeed(3);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PAINT_MIN_INTERVAL_MS - 1);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(wiring.getSnapshot().liveOffset).toBe(600);
    expect(wiring.paintTimer).toBeUndefined();
    expect(wiring.paintDeadline).toBeUndefined();
  });

  it("promotes a pending background frame when the user types", async () => {
    const { wiring } = await setup();
    wiring.paintPacing = { costMs: 1000, intervalMs: 250 };
    wiring.schedulePaint();
    const backgroundDeadline = wiring.paintDeadline!;
    if (wiring.animationTimer) clearInterval(wiring.animationTimer);
    const listener = vi.fn();
    wiring.subscribe(listener);
    vi.advanceTimersByTime(5);
    wiring.handleData("responsive draft");
    expect(wiring.paintDeadline).toBeLessThan(backgroundDeadline);
    expect(wiring.paintDeadline! - wiring.lastPaintAt).toBeLessThanOrEqual(PAINT_MIN_INTERVAL_MS * 2);
    vi.advanceTimersByTime(PAINT_MIN_INTERVAL_MS * 2);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(wiring.getSnapshot().composer.state.text).toBe("responsive draft");
    vi.advanceTimersByTime(250);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not postpone an earlier frame for later requests", async () => {
    const { wiring } = await setup();
    wiring.schedulePaint();
    const deadline = wiring.paintDeadline;
    const timer = wiring.paintTimer;
    wiring.paintPacing = { costMs: 1000, intervalMs: 250 };
    vi.advanceTimersByTime(5);
    wiring.schedulePaint();
    wiring.schedulePaint(true);
    expect(wiring.paintDeadline).toBe(deadline);
    expect(wiring.paintTimer).toBe(timer);
  });

  it("has no continuous paint loop after the requested frame", async () => {
    const { wiring } = await setup();
    const listener = vi.fn();
    wiring.subscribe(listener);
    wiring.schedulePaint(true);
    await vi.advanceTimersByTimeAsync(4000);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a frame for ignored terminal input", async () => {
    const { wiring } = await setup();
    const listener = vi.fn();
    wiring.subscribe(listener);
    wiring.handleData("\x1b[999~");
    await vi.advanceTimersByTimeAsync(100);
    expect(listener).not.toHaveBeenCalled();
  });

  it("repaints an idle composer only when the caret blinks and rests it visible once idle", async () => {
    vi.useFakeTimers();
    harness = createHarness();
    const { wiring } = harness;
    harness.services.focus.focusRegion("composer");
    await vi.advanceTimersByTimeAsync(100);
    const listener = vi.fn();
    wiring.subscribe(listener);
    await vi.advanceTimersByTimeAsync(2000);
    expect(listener.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(listener.mock.calls.length).toBeLessThanOrEqual(5);
    await vi.advanceTimersByTimeAsync(CARET_BLINK_IDLE_MS);
    const settled = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(listener).toHaveBeenCalledTimes(settled);
    expect(wiring.getSnapshot().animationTick % 4).toBeLessThan(2);
    wiring.handleData("x");
    await vi.advanceTimersByTimeAsync(2000);
    expect(listener.mock.calls.length).toBeGreaterThan(settled + 2);
  });

  it("cancels queued paints and ignores input after disposal", async () => {
    const { wiring } = await setup();
    const listener = vi.fn();
    wiring.subscribe(listener);
    wiring.schedulePaint(true);
    wiring.dispose();
    wiring.handleData("ignored");
    await vi.advanceTimersByTimeAsync(500);
    expect(listener).not.toHaveBeenCalled();
    expect(wiring.composer.text).toBe("");
  });

  it("does not update paint costs after a listener disposes the UI", async () => {
    const { wiring } = await setup();
    wiring.subscribe(() => wiring.dispose());
    wiring.schedulePaint(true);
    await vi.advanceTimersByTimeAsync(PAINT_MIN_INTERVAL_MS + 1);
    expect(wiring.disposed).toBe(true);
    expect(wiring.paintPacing).toBe(INITIAL_PAINT_PACING);
  });
});
