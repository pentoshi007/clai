import { TextBufferRenderable } from "@opentui/core";
import { describe, expect, it } from "vitest";
import { patchOpenTuiWheelScroll } from "../../../src/tui-v2/bootstrap/patch-opentui-wheel.js";

interface TextMouseTarget {
  scrolls: number;
  handleScroll(): void;
}

function dispatchWheel(target: TextMouseTarget): void {
  const proto = TextBufferRenderable.prototype as unknown as {
    onMouseEvent(this: unknown, event: { type: string }): void;
  };
  proto.onMouseEvent.call(target, { type: "scroll" });
}

describe("patchOpenTuiWheelScroll", () => {
  it("is idempotent and keeps text renderables from scrolling themselves", () => {
    patchOpenTuiWheelScroll();
    patchOpenTuiWheelScroll();
    const target: TextMouseTarget = {
      scrolls: 0,
      handleScroll() {
        this.scrolls += 1;
      },
    };

    dispatchWheel(target);

    expect(target.scrolls).toBe(0);
  });
});
