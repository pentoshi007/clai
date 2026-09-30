import { describe, expect, it } from "vitest";
import {
  INITIAL_PAINT_PACING,
  PAINT_MAX_INTERVAL_MS,
  PAINT_MIN_INTERVAL_MS,
  nextPaintPacing,
  type PaintPacing,
} from "../../../src/classic/app/paint-pacing.js";

function settle(samples: readonly number[]): PaintPacing {
  return samples.reduce(nextPaintPacing, INITIAL_PAINT_PACING);
}

describe("paint pacing", () => {
  it("keeps the fastest cadence while frames are cheap", () => {
    expect(settle(Array(20).fill(2)).intervalMs).toBe(PAINT_MIN_INTERVAL_MS);
  });

  it("slows the cadence in proportion to a sustained frame cost", () => {
    const pacing = settle(Array(40).fill(40));
    expect(pacing.intervalMs).toBeGreaterThan(PAINT_MIN_INTERVAL_MS);
    expect(pacing.intervalMs).toBeLessThanOrEqual(PAINT_MAX_INTERVAL_MS);
    expect(pacing.intervalMs).toBeCloseTo(160, -1);
  });

  it("never exceeds the ceiling however slow the device is", () => {
    expect(settle(Array(40).fill(5_000)).intervalMs).toBe(PAINT_MAX_INTERVAL_MS);
  });

  it("recovers the fast cadence once frames are cheap again", () => {
    const slow = settle(Array(40).fill(60));
    const recovered = Array(40).fill(1).reduce(nextPaintPacing, slow);
    expect(recovered.intervalMs).toBe(PAINT_MIN_INTERVAL_MS);
  });

  it("ignores a single spike instead of stalling the feed", () => {
    const spiked = nextPaintPacing(INITIAL_PAINT_PACING, 100);
    expect(spiked.intervalMs).toBeLessThan(PAINT_MAX_INTERVAL_MS);
  });

  it("treats invalid samples as free", () => {
    expect(nextPaintPacing(INITIAL_PAINT_PACING, Number.NaN).intervalMs).toBe(PAINT_MIN_INTERVAL_MS);
    expect(nextPaintPacing(INITIAL_PAINT_PACING, -5).intervalMs).toBe(PAINT_MIN_INTERVAL_MS);
  });
});
