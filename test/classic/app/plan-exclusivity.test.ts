import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionPlan } from "../../../src/store/plan.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const PLAN: SessionPlan = {
  sessionId: "s1",
  goal: "Ship the thing",
  detail: "",
  tasks: [
    { id: "t1", title: "Do first", state: "done" },
    { id: "t2", title: "Do second", state: "pending" },
  ],
  status: "in_progress",
  kind: "general",
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

describe("tasks/plan exclusivity", () => {
  it("hides the tasks strip when the plan detail pager opens", async () => {
    harness = createHarness();
    vi.spyOn(harness.services.plan, "current").mockReturnValue(PLAN);
    harness.wiring.togglePlan();
    expect(harness.wiring.planVisibleValue).toBe(true);
    await harness.wiring.openPlanDetail();
    expect(harness.services.overlay.isOpen()).toBe(true);
    expect(harness.wiring.planVisibleValue).toBe(false);
  });

  it("closes an open overlay when the tasks strip is shown", () => {
    harness = createHarness();
    vi.spyOn(harness.services.plan, "current").mockReturnValue(PLAN);
    harness.services.overlay.openPager("Something", "doc", undefined, undefined, "force");
    expect(harness.services.overlay.isOpen()).toBe(true);
    harness.wiring.togglePlan();
    expect(harness.wiring.planVisibleValue).toBe(true);
    expect(harness.services.overlay.isOpen()).toBe(false);
  });
});