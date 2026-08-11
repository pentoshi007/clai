import { describe, expect, it } from "vitest";
import {
  padToastLines,
  wrapToastBody,
} from "../../src/tui-v2/components/toast/toast-host.js";
import {
  TOAST_BOX_HEIGHT,
  toastAnimAt,
} from "../../src/tui-v2/components/toast/toast-anim.js";
import { MAX_TOAST_MESSAGE_CHARS } from "../../src/ui-core/controllers/toast-controller.js";
import { TOAST_ENTER_MS } from "../../src/ui-core/controllers/toast-controller.js";

describe("toast notification chip", () => {
  it("min chip height is 3 (pad + body + pad)", () => {
    expect(TOAST_BOX_HEIGHT).toBe(3);
  });

  it("wraps long messages to inner width without exceeding it", () => {
    const msg =
      "session resumed · long title here · plan “huge goal name” · 42 items · 99 model messages";
    const lines = wrapToastBody("info", msg, 28);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(28);
    }
    expect(lines.join(" ")).toContain("session resumed");
  });

  it("pads wrapped lines to full chip width", () => {
    const body = wrapToastBody("warn", "hello world", 20);
    const padded = padToastLines(body, 24);
    for (const line of padded) {
      expect(line.length).toBe(24);
    }
  });

  it("animates multi-line height off-screen fully", () => {
    const tall = 8;
    const start = toastAnimAt(0, 2000, tall);
    expect(start.top).toBe(-tall);
    const hold = toastAnimAt(TOAST_ENTER_MS + 50, 2000, tall);
    expect(hold.phase).toBe("hold");
    expect(hold.top).toBe(1);
  });

  it("allows long status lines through the controller cap", () => {
    expect(MAX_TOAST_MESSAGE_CHARS).toBeGreaterThanOrEqual(200);
  });
});
