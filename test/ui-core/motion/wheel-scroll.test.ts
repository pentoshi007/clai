import { describe, expect, it } from "vitest";
import {
  WHEEL_FRAME_MS,
  WHEEL_MAX_FRAME_MS,
  WheelScroll,
} from "../../../src/ui-core/motion/wheel-scroll.js";

function glide(wheel: WheelScroll, start: number, frameMs = WHEEL_FRAME_MS): number[] {
  const steps: number[] = [];
  for (let now = start + frameMs; wheel.active && steps.length < 1_000; now += frameMs) {
    steps.push(wheel.step(now));
  }
  return steps;
}

describe("wheel scroll glide", () => {
  it("moves an isolated notch exactly one row on the next frame with no idle work", () => {
    const wheel = new WheelScroll();
    wheel.push(1, 0);
    expect(wheel.step(WHEEL_FRAME_MS)).toBe(1);
    expect(wheel.active).toBe(false);
    expect(wheel.step(2 * WHEEL_FRAME_MS)).toBe(0);
    wheel.push(-1, 100);
    expect(wheel.step(100 + WHEEL_FRAME_MS)).toBe(-1);
  });

  it("spreads a burst over consecutive frames with an ease-out and exact distance", () => {
    const wheel = new WheelScroll();
    for (let index = 0; index < 120; index += 1) wheel.push(-1, 0);
    const steps = glide(wheel, 0);
    expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-120);
    expect(steps.every((rows) => rows < 0 && Number.isInteger(rows))).toBe(true);
    expect(Math.abs(steps[0]!)).toBeGreaterThan(1);
    expect(Math.abs(steps[0]!)).toBeLessThan(120);
    for (let index = 1; index < steps.length; index += 1) {
      expect(Math.abs(steps[index]!)).toBeLessThanOrEqual(Math.abs(steps[index - 1]!));
    }
    expect(steps.length * WHEEL_FRAME_MS).toBeLessThan(400);
  });

  it("covers the same distance in the same time at any frame cadence", () => {
    const durations = [WHEEL_FRAME_MS, 2 * WHEEL_FRAME_MS, 40].map((frameMs) => {
      const wheel = new WheelScroll();
      wheel.push(60, 0);
      const steps = glide(wheel, 0, frameMs);
      expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(60);
      return steps.length * frameMs;
    });
    expect(Math.max(...durations) - Math.min(...durations)).toBeLessThanOrEqual(80);
  });

  it("does not dump a backlog in one frame after the renderer was idle", () => {
    const wheel = new WheelScroll();
    wheel.push(120, 0);
    const rows = wheel.step(5_000);
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThan(120);
    const capped = new WheelScroll();
    capped.push(120, 0);
    expect(capped.step(WHEEL_MAX_FRAME_MS - WHEEL_FRAME_MS)).toBe(rows);
  });

  it("drops the unfinished glide when the direction reverses", () => {
    const wheel = new WheelScroll();
    wheel.push(10, 0);
    expect(wheel.step(WHEEL_FRAME_MS)).toBeGreaterThan(0);
    wheel.push(-1, WHEEL_FRAME_MS);
    expect(wheel.step(2 * WHEEL_FRAME_MS)).toBe(-1);
    expect(wheel.active).toBe(false);
  });

  it("hands over everything pending on take", () => {
    const wheel = new WheelScroll();
    wheel.push(3, 0);
    wheel.push(4, 1);
    expect(wheel.take()).toBe(7);
    expect(wheel.active).toBe(false);
    expect(wheel.take()).toBe(0);
  });

  it("discards pending input on demand", () => {
    const wheel = new WheelScroll();
    wheel.push(20, 0);
    wheel.stop();
    expect(wheel.active).toBe(false);
    expect(wheel.step(WHEEL_FRAME_MS)).toBe(0);
  });

  it("ignores zero and invalid deltas without disturbing pending input", () => {
    const wheel = new WheelScroll();
    wheel.push(5, 0);
    for (const value of [0, NaN, Infinity, -Infinity]) wheel.push(value, 0);
    expect(glide(wheel, 0).reduce((sum, rows) => sum + rows, 0)).toBe(5);
  });
});
