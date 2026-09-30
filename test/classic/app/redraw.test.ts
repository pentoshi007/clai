import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "./harness.js";

const F5 = "\x1b[15~";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function withRedraw(): { readonly h: Harness; readonly requestRedraw: ReturnType<typeof vi.fn> } {
  const requestRedraw = vi.fn(() => true);
  const h = createHarness({ commands: true, requestRedraw });
  harness = h;
  return { h, requestRedraw };
}

describe("redrawing the Classic screen", () => {
  it.each(["composer", "transcript", "plan"] as const)(
    "repaints on F5 while the %s has focus",
    (region) => {
      const { h, requestRedraw } = withRedraw();
      h.services.focus.focusRegion(region);
      h.wiring.handleData(F5);
      expect(requestRedraw).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the draft and the focus untouched", () => {
    const { h, requestRedraw } = withRedraw();
    h.wiring.handleData("keep me");
    h.wiring.handleData(F5);
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    expect(h.wiring.composer.text).toBe("keep me");
    expect(h.services.focus.activeContext()).toBe("composer");
  });

  it("repaints from behind a picker without closing it", () => {
    const { h, requestRedraw } = withRedraw();
    h.services.overlay.openPicker(
      { title: "Pick", options: [{ value: "a", label: "a", description: "" }] },
      () => undefined,
    );
    h.wiring.handleData(F5);
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    expect(h.services.overlay.isOpen()).toBe(true);
  });

  it("repaints from behind a pager without closing it", () => {
    const { h, requestRedraw } = withRedraw();
    h.services.overlay.openPager("Output", "line\n".repeat(80), undefined, undefined, "plain");
    h.wiring.handleData(F5);
    expect(requestRedraw).toHaveBeenCalledTimes(1);
    expect(h.services.overlay.isOpen()).toBe(true);
  });

  it("does not repaint for other function keys", () => {
    const { h, requestRedraw } = withRedraw();
    h.wiring.handleData("\x1b[17~");
    expect(requestRedraw).not.toHaveBeenCalled();
  });
});
