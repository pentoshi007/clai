import { describe, expect, it } from "vitest";
import { WheelScroll } from "../../../src/ui-core/motion/wheel-scroll.js";

function replay(frameMs: number, inputMs: number, durationMs: number) {
  const wheel = new WheelScroll();
  let nextInput = 0;
  let received = 0;
  let travelled = 0;
  let maxBacklog = 0;
  let movingFrames = 0;
  for (let now = frameMs; now <= durationMs + frameMs; now += frameMs) {
    while (nextInput < durationMs && nextInput <= now) {
      wheel.push(1);
      received += 1;
      nextInput += inputMs;
    }
    const rows = wheel.take();
    if (rows !== 0) movingFrames += 1;
    travelled += rows;
    maxBacklog = Math.max(maxBacklog, received - travelled);
  }
  return { wheel, received, travelled, maxBacklog, movingFrames };
}

describe("wheel scroll latency budget", () => {
  it.each([8, 17, 33, 50, 100])("leaves no backlog behind a %ims frame", (frameMs) => {
    const result = replay(frameMs, 4, 1000);
    expect(result.travelled).toBe(result.received);
    expect(result.maxBacklog).toBe(0);
    expect(result.wheel.active).toBe(false);
  });

  it.each([17, 33, 50])("paints at most one moving frame per %ims frame however fast input arrives", (frameMs) => {
    const result = replay(frameMs, 1, 1000);
    expect(result.received).toBe(1000);
    expect(result.movingFrames).toBeLessThanOrEqual(Math.ceil(1000 / frameMs));
  });

  it("keeps sparse input precise rather than accelerating it", () => {
    const wheel = new WheelScroll();
    const steps: number[] = [];
    for (let notch = 0; notch < 20; notch += 1) {
      wheel.push(1);
      steps.push(wheel.take());
      steps.push(wheel.take());
    }
    expect(steps.filter((rows) => rows !== 0)).toEqual(Array.from({ length: 20 }, () => 1));
  });
});
