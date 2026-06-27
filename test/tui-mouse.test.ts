import { describe, expect, it } from "vitest";
import { isMouseReport, mouseWheelDirection, stripMouseReports } from "../src/tui/mouse.js";

describe("TUI mouse wheel decoding", () => {
  it("distinguishes wheel scrolling from keyboard arrows", () => {
    expect(mouseWheelDirection("\x1b[<64;80;20M")).toBe(-1);
    expect(mouseWheelDirection("\x1b[<65;80;20M")).toBe(1);
    expect(mouseWheelDirection("\x1b[A")).toBe(0);
  });

  it("strips full and partial mouse reports before composer insertion", () => {
    expect(isMouseReport("\x1b[<64;85;26M")).toBe(true);
    expect(isMouseReport("[<64;85;26M")).toBe(true);
    expect(isMouseReport("64;85;26M")).toBe(true);
    expect(stripMouseReports("hello[<64;85;26M world")).toBe("hello world");
    expect(stripMouseReports("64;85;26M")).toBe("");
  });
});
