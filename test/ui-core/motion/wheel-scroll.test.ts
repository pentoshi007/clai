import { describe, expect, it } from "vitest";
import { WheelScroll } from "../../../src/ui-core/motion/wheel-scroll.js";

function drain(wheel: WheelScroll): number[] {
  const steps: number[] = [];
  while (wheel.active) steps.push(wheel.step());
  return steps;
}

describe("wheel scroll motion", () => {
  it("moves an isolated notch in one frame with no idle work", () => {
    const wheel = new WheelScroll();
    wheel.push(1);
    expect(drain(wheel)).toEqual([1]);
    expect(wheel.active).toBe(false);
    expect(wheel.step()).toBe(0);
    wheel.push(-1);
    expect(drain(wheel)).toEqual([-1]);
  });

  it("preserves the distance of dense trackpad streams", () => {
    const wheel = new WheelScroll();
    let travelled = 0;
    for (let index = 1; index <= 40; index += 1) {
      wheel.push(1);
      if (index % 2 === 0) travelled += wheel.step();
    }
    travelled += drain(wheel).reduce((sum, rows) => sum + rows, 0);
    expect(travelled).toBe(40);
  });

  it("keeps steady-stream steps within two rows", () => {
    const wheel = new WheelScroll();
    const steps: number[] = [];
    for (let frame = 0; frame < 60; frame += 1) {
      wheel.push(2);
      steps.push(wheel.step());
    }
    steps.push(...drain(wheel));
    expect(Math.max(...steps)).toBeLessThanOrEqual(2);
    expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(120);
  });

  it("drops the remaining glide when the direction reverses", () => {
    const wheel = new WheelScroll();
    wheel.push(10);
    expect(wheel.step()).toBe(2);
    wheel.push(-1);
    expect(drain(wheel)).toEqual([-1]);
  });

  it("drains a large coalesced event without jumping or losing rows", () => {
    const wheel = new WheelScroll();
    wheel.push(-120);
    const steps = drain(wheel);
    expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-120);
    expect(steps.every(rows => rows === -1 || rows === -2)).toBe(true);
    expect(wheel.active).toBe(false);
  });

  it("travels every row of a burst and stops on demand", () => {
    const wheel = new WheelScroll();
    for (let index = 0; index < 20; index += 1) wheel.push(-1);
    const steps = drain(wheel);
    expect(steps.reduce((sum, rows) => sum + rows, 0)).toBe(-20);
    expect(steps.every(rows => Math.abs(rows) <= 2)).toBe(true);
    wheel.push(1);
    wheel.stop();
    expect(wheel.active).toBe(false);
    expect(wheel.step()).toBe(0);
  });

  it("ignores zero input without interrupting a glide", () => {
    const wheel = new WheelScroll();
    wheel.push(5);
    wheel.push(0);
    expect(drain(wheel).reduce((sum, rows) => sum + rows, 0)).toBe(5);
  });
});
