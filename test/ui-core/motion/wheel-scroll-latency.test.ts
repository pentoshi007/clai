import { describe, expect, it } from "vitest";
import { WheelScroll } from "../../../src/ui-core/motion/wheel-scroll.js";

function replay(frameMs: number, inputMs: number, durationMs: number) {
  const wheel = new WheelScroll();
  let nextInput = 0;
  let received = 0;
  let travelled = 0;
  let maxBacklog = 0;
  let finishedAt = 0;
  const steps: number[] = [];
  for (let now = frameMs; now <= durationMs + 100; now += frameMs) {
    while (nextInput < durationMs && nextInput <= now) {
      wheel.push(1, nextInput);
      received += 1;
      nextInput += inputMs;
    }
    const rows = wheel.step(now);
    travelled += rows;
    maxBacklog = Math.max(maxBacklog, received - travelled);
    steps.push(rows);
    finishedAt = now;
    if (nextInput >= durationMs && !wheel.active) break;
  }
  return { wheel, received, travelled, maxBacklog, finishedAt, steps };
}

describe("wheel scroll latency budget", () => {
  it.each([8, 17, 33, 50, 100])("finishes a coalesced burst within 50ms plus a %ims frame", (frameMs) => {
    const wheel = new WheelScroll();
    wheel.push(-120, 0);
    const steps: number[] = [];
    let elapsed = 0;
    while (wheel.active && elapsed <= 50) {
      elapsed += frameMs;
      steps.push(wheel.step(elapsed));
    }
    expect(wheel.active).toBe(false);
    expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-120);
    expect(elapsed).toBeLessThanOrEqual(50 + frameMs);
    if (frameMs < 50) expect(steps.length).toBeGreaterThan(1);
  });

  it.each([8, 17, 33, 50])("tracks a 250Hz gesture without accumulating seconds of lag at %ims/frame", (frameMs) => {
    const result = replay(frameMs, 4, 1000);
    expect(result.travelled).toBe(result.received);
    expect(result.wheel.active).toBe(false);
    expect(result.finishedAt).toBeLessThanOrEqual(1050 + frameMs);
    expect(result.maxBacklog).toBeLessThanOrEqual(13);
    expect(result.steps.every((rows) => rows >= 0)).toBe(true);
  });

  it("keeps sparse input precise rather than accelerating it", () => {
    const result = replay(17, 50, 1000);
    expect(result.travelled).toBe(20);
    expect(Math.max(...result.steps)).toBe(1);
    expect(result.wheel.active).toBe(false);
  });

  it("catches up after a blocked frame instead of replaying stale input", () => {
    const wheel = new WheelScroll();
    wheel.push(120, 0);
    expect(wheel.step(17)).toBeGreaterThan(2);
    const remaining = wheel.step(250);
    expect(remaining).toBeGreaterThan(0);
    expect(wheel.active).toBe(false);
    expect(wheel.step(267)).toBe(0);
  });

  it("reverses on the next frame even during a dense gesture", () => {
    const wheel = new WheelScroll();
    wheel.push(120, 0);
    wheel.step(17);
    wheel.push(-1, 20);
    expect(wheel.step(33)).toBe(-1);
    expect(wheel.active).toBe(false);
  });

  it("starts a fresh timing budget after stopping", () => {
    const wheel = new WheelScroll();
    wheel.push(120, 0);
    wheel.step(17);
    wheel.stop();
    wheel.push(20, 10000);
    expect(wheel.step(10017)).toBe(7);
    expect(wheel.active).toBe(true);
    expect(wheel.step(10034)).toBe(7);
    expect(wheel.step(10051)).toBe(6);
    expect(wheel.active).toBe(false);
  });

  it("does not let invalid deltas poison a running gesture", () => {
    const wheel = new WheelScroll();
    wheel.push(5, 0);
    for (const value of [NaN, Infinity, -Infinity]) wheel.push(value, 5);
    expect(wheel.step(50)).toBe(5);
    expect(wheel.active).toBe(false);
  });
});
