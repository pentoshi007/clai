import { describe, expect, it } from "vitest";
import {
  modeIndicatorPresentation,
  responderStatusText,
  statusDensityForWidth,
  tasksToggleLabel,
} from "../../src/ui-core/rendering/status-segments.js";

describe("composer mode indicator", () => {
  it("maps width to density tiers", () => {
    expect(statusDensityForWidth(40)).toBe("xs");
    expect(statusDensityForWidth(55)).toBe("sm");
    expect(statusDensityForWidth(80)).toBe("md");
    expect(statusDensityForWidth(100)).toBe("lg");
  });

  it("labels the active Tasks pane action by density", () => {
    expect(tasksToggleLabel(true, "lg")).toBe("Tasks");
    expect(tasksToggleLabel(false, "lg")).toBe("Tasks");
    expect(tasksToggleLabel(true, "md")).toBe("Tasks");
    expect(tasksToggleLabel(false, "md")).toBe("Tasks");
    expect(tasksToggleLabel(true, "sm")).toBe("Tasks");
    expect(tasksToggleLabel(false, "sm")).toBe("Tasks");
    expect(tasksToggleLabel(true, true)).toBe("Tasks");
    expect(tasksToggleLabel(false, false)).toBe("Tasks");
  });

  it("presents concise, distinct copy for every live session mode", () => {
    expect(modeIndicatorPresentation("ask")).toEqual({
      label: "ASK",
      description: "",
    });
    expect(modeIndicatorPresentation("agent")).toEqual({
      label: "AGENT",
      description: "",
    });
    expect(modeIndicatorPresentation("plan")).toEqual({
      label: "PLAN",
      description: "",
    });
  });

  it("formats responder lifecycle state and counts", () => {
    expect(
      responderStatusText({
        mode: "listening",
        running: 2,
        ready: 1,
        delivered: 0,
        archived: 0,
        failed: 0,
      }),
    ).toBe("Responder: listening · 2 running · 1 ready");
    expect(
      responderStatusText({
        mode: "off",
        running: 1,
        ready: 0,
        delivered: 0,
        archived: 2,
        failed: 0,
      }),
    ).toBe("Responder: off · 3 pending");
    expect(
      responderStatusText({
        mode: "idle",
        running: 0,
        ready: 0,
        delivered: 0,
        archived: 0,
        failed: 0,
      }),
    ).toBe("Responder: idle");
  });
});
