import { describe, expect, it } from "vitest";
import { WheelScroll } from "../../../src/ui-core/motion/wheel-scroll.js";

describe("wheel scroll input", () => {
  it("moves an isolated notch exactly one row with no idle work", () => {
    const wheel = new WheelScroll();
    wheel.push(1);
    expect(wheel.take()).toBe(1);
    expect(wheel.active).toBe(false);
    expect(wheel.take()).toBe(0);
    wheel.push(-1);
    expect(wheel.take()).toBe(-1);
  });

  it("delivers a whole burst in the next step instead of replaying it over later frames", () => {
    const wheel = new WheelScroll();
    for (let index = 0; index < 120; index += 1) wheel.push(-1);
    expect(wheel.take()).toBe(-120);
    expect(wheel.active).toBe(false);
  });

  it("preserves the distance of dense trackpad streams at any frame cadence", () => {
    const wheel = new WheelScroll();
    let travelled = 0;
    for (let index = 1; index <= 40; index += 1) {
      wheel.push(1);
      if (index % 3 === 0) travelled += wheel.take();
    }
    travelled += wheel.take();
    expect(travelled).toBe(40);
  });

  it("nets out a reversal that arrives before the next frame", () => {
    const wheel = new WheelScroll();
    wheel.push(3);
    wheel.push(-1);
    expect(wheel.take()).toBe(2);
    wheel.push(-2);
    wheel.push(2);
    expect(wheel.active).toBe(false);
    expect(wheel.take()).toBe(0);
  });

  it("discards pending input on demand", () => {
    const wheel = new WheelScroll();
    wheel.push(20);
    wheel.stop();
    expect(wheel.active).toBe(false);
    expect(wheel.take()).toBe(0);
  });

  it("ignores zero and invalid deltas without disturbing pending input", () => {
    const wheel = new WheelScroll();
    wheel.push(5);
    for (const value of [0, NaN, Infinity, -Infinity]) wheel.push(value);
    expect(wheel.take()).toBe(5);
  });
});
