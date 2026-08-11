import { describe, expect, it } from "vitest";
import { FocusController } from "../../../src/ui-core/controllers/focus-controller.js";

describe("FocusController inputCaptured flag", () => {
  it("exposes inputCaptured false by default", () => {
    const focus = new FocusController("composer");
    expect(focus.inputCaptured).toBe(false);
  });

  it("sets inputCaptured true when captured", () => {
    const focus = new FocusController("composer");
    focus.setInputCaptured(true);
    expect(focus.inputCaptured).toBe(true);
  });

  it("sets inputCaptured false when released", () => {
    const focus = new FocusController("composer");
    focus.setInputCaptured(true);
    expect(focus.inputCaptured).toBe(true);
    focus.setInputCaptured(false);
    expect(focus.inputCaptured).toBe(false);
  });

  it("keeps inputCaptured across region changes (explicit release required)", () => {
    const focus = new FocusController("composer");
    focus.setInputCaptured(true);
    focus.focusRegion("transcript");
    expect(focus.inputCaptured).toBe(true);
  });
});
