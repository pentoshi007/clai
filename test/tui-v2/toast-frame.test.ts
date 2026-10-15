import { describe, expect, it } from "vitest";
import {
  TOAST_MIN_CHIP_WIDTH,
  padToastLines,
  toastChipWidth,
  wrapToastBody,
} from "../../src/tui-v2/components/toast/toast-host.js";
import {
  TOAST_BOX_HEIGHT,
  toastAnimAt,
} from "../../src/tui-v2/components/toast/toast-anim.js";
import { MAX_TOAST_MESSAGE_CHARS } from "../../src/ui-core/controllers/toast-controller.js";
import { TOAST_ENTER_MS } from "../../src/ui-core/controllers/toast-controller.js";

describe("toast notification chip", () => {
  it("min chip height is 1 (body only; padding is horizontal)", () => {
    expect(TOAST_BOX_HEIGHT).toBe(1);
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

  it("centers each toast body line inside its padding", () => {
    expect(padToastLines(["!  hello world", "   short"], 24)).toEqual([
      "     !  hello world     ",
      "         short          ",
    ]);
    expect(padToastLines(["·  文件"], 16)).toEqual(["    ·  文件     "]);
  });

  it.each([1, 8, 16, 24, 40, 80, 120])("keeps centered text within %i columns", width => {
    const line = padToastLines(["·  long toast message"], width)[0]!;
    expect(line.length).toBe(width);
    const leading = line.length - line.trimStart().length;
    const trailing = line.length - line.trimEnd().length;
    expect(Math.abs(leading - trailing)).toBeLessThanOrEqual(1);
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

describe("toast chip width fits its content", () => {
  it("shrinks a short toast to the minimum chip width", () => {
    expect(TOAST_MIN_CHIP_WIDTH).toBe(16);
    expect(toastChipWidth("info", "hi", 80)).toBe(16);
    expect(toastChipWidth("error", "Failed", 120)).toBe(16);
  });

  it("sizes a single-line toast to its content plus padding", () => {
    expect(toastChipWidth("info", "Centered text", 80)).toBe(20);
    expect(toastChipWidth("success", "saved", 80)).toBe(16);
    const status = "provider → River · model → deepseek-ai/DeepSeek-V4.1-Flash";
    expect(toastChipWidth("info", status, 120)).toBe(status.length + 3 + 4);
  });

  it("caps a long toast at the maximum width", () => {
    expect(toastChipWidth("warn", "x".repeat(400), 80)).toBe(80);
    expect(toastChipWidth("warn", "x".repeat(400), 40)).toBe(40);
  });

  it("measures CJK content by display columns", () => {
    expect(toastChipWidth("warn", "保存完了 続行できます", 80)).toBe(28);
  });

  it("never exceeds the terminal width on narrow terminals", () => {
    for (const width of [10, 16, 20, 24]) {
      expect(toastChipWidth("info", "a long toast message that wraps", width)).toBeLessThanOrEqual(width);
    }
  });
});
