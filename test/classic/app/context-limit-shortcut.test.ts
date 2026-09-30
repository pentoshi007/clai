import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const CTRL_L = "\x0c";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

describe("Ctrl+L opens the context limit editor", () => {
  it.each(["composer", "transcript", "plan"] as const)(
    "while the %s has focus",
    (region) => {
      harness = createHarness({ commands: true });
      harness.services.focus.focusRegion(region);
      harness.wiring.handleData(CTRL_L);
      expect(harness.wiring.contextLimitEditingValue).toBe(true);
      expect(harness.services.focus.activeContext()).toBe("composer");
    },
  );

  it("after the transcript was scrolled by touch or wheel", () => {
    harness = createHarness({ commands: true });
    harness.services.focus.focusRegion("transcript");
    harness.wiring.handleData("hello");
    harness.services.focus.focusRegion("transcript");
    harness.wiring.handleData(CTRL_L);
    expect(harness.wiring.contextLimitEditingValue).toBe(true);
  });

  it("stays closed while an overlay owns the keyboard", () => {
    harness = createHarness({ commands: true });
    harness.services.overlay.openPicker(
      { title: "Pick", options: [{ value: "a", label: "a", description: "" }] },
      () => undefined,
    );
    harness.wiring.handleData(CTRL_L);
    expect(harness.wiring.contextLimitEditingValue).toBe(false);
  });
});
