import { describe, expect, it } from "vitest";
import {
  PLAN_PANE_ENTER_MS,
  PLAN_PANE_EXIT_MS,
  paneMounted,
  panePhaseComplete,
  paneProgress,
  paneSlideTop,
  paneSlideWidth,
} from "../../src/tui-v2/components/plan/plan-pane-anim.js";
import { easeInCubic, easeOutCubic } from "../../src/ui-core/motion/ease.js";

describe("plan pane animation", () => {
  it("enters from 0 to 1 with ease-out over enter ms", () => {
    expect(paneProgress("enter", 0)).toBe(0);
    const mid = paneProgress("enter", PLAN_PANE_ENTER_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // ease-out is ahead of linear at midpoint
    expect(mid).toBeGreaterThan(0.5);
    expect(paneProgress("enter", PLAN_PANE_ENTER_MS)).toBe(1);
    expect(paneProgress("open", 0)).toBe(1);
  });

  it("exits from 1 to 0 with ease-in over exit ms", () => {
    expect(paneProgress("exit", 0)).toBe(1);
    const mid = paneProgress("exit", PLAN_PANE_EXIT_MS / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    // ease-in is behind linear at midpoint (still higher progress)
    expect(mid).toBeGreaterThan(0.5);
    expect(paneProgress("exit", PLAN_PANE_EXIT_MS)).toBe(0);
    expect(paneProgress("closed", 0)).toBe(0);
  });

  it("mounted only while enter/open/exit", () => {
    expect(paneMounted("closed")).toBe(false);
    expect(paneMounted("enter")).toBe(true);
    expect(paneMounted("open")).toBe(true);
    expect(paneMounted("exit")).toBe(true);
  });

  it("phase complete advances enter→open and exit→closed", () => {
    expect(panePhaseComplete("enter", PLAN_PANE_ENTER_MS - 1)).toBeNull();
    expect(panePhaseComplete("enter", PLAN_PANE_ENTER_MS)).toBe("open");
    expect(panePhaseComplete("exit", PLAN_PANE_EXIT_MS - 1)).toBeNull();
    expect(panePhaseComplete("exit", PLAN_PANE_EXIT_MS)).toBe("closed");
    expect(panePhaseComplete("open", 9999)).toBeNull();
    expect(panePhaseComplete("closed", 9999)).toBeNull();
  });

  it("slide top starts above viewport and settles at rest", () => {
    const rest = 3;
    const h = 20;
    expect(paneSlideTop(0, rest, h)).toBe(-h);
    expect(paneSlideTop(1, rest, h)).toBe(rest);
    const mid = paneSlideTop(0.5, rest, h);
    expect(mid).toBeGreaterThan(-h);
    expect(mid).toBeLessThan(rest);
  });

  it("slide width grows from 0 to full", () => {
    expect(paneSlideWidth(0, 40)).toBe(0);
    expect(paneSlideWidth(1, 40)).toBe(40);
    expect(paneSlideWidth(0.5, 40)).toBe(20);
  });

  it("shared ease matches toast curves", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeInCubic(0.5)).toBeLessThan(0.5);
  });
});
