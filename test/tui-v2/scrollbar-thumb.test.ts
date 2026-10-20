import { describe, expect, it } from "vitest";
import { sameThumbLayout, thumbRange } from "../../src/tui-v2/components/transcript/transcript-scrollbar.js";

const metrics = (scrollTop: number, overrides: Partial<{ scrollHeight: number; viewportHeight: number; y: number }> = {}) => ({
  scrollTop,
  scrollHeight: overrides.scrollHeight ?? 1_000,
  viewportHeight: overrides.viewportHeight ?? 30,
  y: overrides.y ?? 0,
});

describe("scrollbar thumb layout", () => {
  it("treats scroll positions that draw the same thumb as unchanged", () => {
    const a = metrics(0);
    const b = metrics(3);
    expect(thumbRange(a)).toEqual(thumbRange(b));
    expect(sameThumbLayout(a, b)).toBe(true);
  });

  it("reports a change once the thumb moves", () => {
    let moved = 0;
    while (sameThumbLayout(metrics(0), metrics(moved))) moved += 1;
    expect(thumbRange(metrics(moved))!.top).toBeGreaterThan(thumbRange(metrics(0))!.top);
    expect(moved).toBeLessThan(970);
  });

  it("reports a change when the track moves, resizes, or appears", () => {
    expect(sameThumbLayout(metrics(0), metrics(0, { y: 1 }))).toBe(false);
    expect(sameThumbLayout(metrics(0), metrics(0, { viewportHeight: 31 }))).toBe(false);
    expect(sameThumbLayout(metrics(0, { scrollHeight: 20 }), metrics(0))).toBe(false);
    expect(sameThumbLayout(metrics(0, { scrollHeight: 20 }), metrics(0, { scrollHeight: 25 }))).toBe(true);
  });
});
