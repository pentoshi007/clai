import { describe, expect, it } from "vitest";
import { WHEEL_FRAME_MS, WheelScroll } from "../../../src/ui-core/motion/wheel-scroll.js";

interface Burst {
  readonly at: number;
  readonly notches: number;
}

function replay(frameMs: number, input: readonly Burst[], tailMs = 1_000) {
  const wheel = new WheelScroll();
  const end = (input.at(-1)?.at ?? 0) + tailMs;
  const steps: Array<{ at: number; rows: number }> = [];
  let next = 0;
  let received = 0;
  let travelled = 0;
  for (let now = frameMs; now <= end; now += frameMs) {
    while (next < input.length && input[next]!.at <= now) {
      wheel.push(input[next]!.notches, input[next]!.at);
      received += input[next]!.notches;
      next += 1;
    }
    const rows = wheel.step(now);
    travelled += rows;
    steps.push({ at: now, rows });
  }
  const lastInputAt = input.at(-1)?.at ?? 0;
  const settledAt = steps.filter((step) => step.rows !== 0).at(-1)?.at ?? 0;
  return { wheel, received, travelled, steps, settleMs: settledAt - lastInputAt };
}

function stream(intervalMs: number, notches: number, durationMs: number): Burst[] {
  return Array.from({ length: Math.floor(durationMs / intervalMs) }, (_, index) => ({ at: index * intervalMs, notches }));
}

describe("wheel scroll latency budget", () => {
  it.each([8, 17, 33, 50])("delivers every notch and settles promptly behind a %ims frame", (frameMs) => {
    const result = replay(frameMs, stream(4, 1, 1_000));
    expect(result.travelled).toBe(result.received);
    expect(result.wheel.active).toBe(false);
    expect(result.settleMs).toBeLessThanOrEqual(250);
  });

  it("turns bursty remote input into continuous, even motion", () => {
    const bursts = Array.from({ length: 20 }, (_, index) => ({ at: index * 55, notches: 6 }));
    const result = replay(WHEEL_FRAME_MS, bursts);
    expect(result.travelled).toBe(120);
    const streaming = result.steps.filter((step) => step.at >= 55 && step.at <= 19 * 55);
    expect(streaming.every((step) => step.rows >= 1 && step.rows <= 3)).toBe(true);
  });

  it("follows a steady trackpad stream at its own speed without drifting behind", () => {
    const result = replay(WHEEL_FRAME_MS, stream(8, 1, 2_000));
    const steady = result.steps.filter((step) => step.at >= 500 && step.at <= 1_900);
    expect(steady.every((step) => step.rows >= 1 && step.rows <= 3)).toBe(true);
    expect(result.settleMs).toBeLessThanOrEqual(150);
  });

  it("keeps sparse input precise rather than accelerating it", () => {
    const wheel = new WheelScroll();
    const steps: number[] = [];
    for (let notch = 0; notch < 20; notch += 1) {
      const at = notch * 100;
      wheel.push(1, at);
      steps.push(wheel.step(at + WHEEL_FRAME_MS));
      steps.push(wheel.step(at + 2 * WHEEL_FRAME_MS));
    }
    expect(steps.filter((rows) => rows !== 0)).toEqual(Array.from({ length: 20 }, () => 1));
  });
});
