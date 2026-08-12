import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  armedCancelHint,
  busyCancelHint,
  cwdViewportWidth,
  idleHintIds,
  statusDensityForWidth,
} from "../../src/ui-core/rendering/status-segments.js";
import {
  contextChipForDensity,
  parseContextLimitInput,
  type StatusDensity,
} from "../../src/ui-core/rendering/context-limit.js";

const DENSITIES: StatusDensity[] = ["xs", "sm", "md", "lg"];
const STATUS_LINE = "src/tui-v2/components/status/status-line.tsx";
const APP = "src/tui-v2/app/App.tsx";

describe("status line hints and Esc semantics", () => {
  it("uses a compact cancel hint and a direct second-Esc instruction", () => {
    for (const density of DENSITIES) {
      expect(busyCancelHint(density)).toEqual({
        short: "esc: cancel",
        expand: "cancel active work",
      });
    }
    expect(armedCancelHint()).toBe("esc again to cancel");
  });

  it("thins the optional idle chord row and hides it entirely when narrow", () => {
    expect(idleHintIds("xs")).toEqual([]);
    expect(idleHintIds("sm")).toEqual([]);
    expect(idleHintIds("md")).toEqual(["commands", "thinking", "output"]);
    expect(idleHintIds("lg")).toEqual(["commands", "thinking", "output"]);
    expect(idleHintIds("xs", true)).toEqual([]);
    expect(idleHintIds("sm", true)).toEqual(["cut-draft", "clear-draft"]);
    expect(idleHintIds("md", true)).toEqual(["commands", "cut-draft", "clear-draft", "thinking", "output"]);
    expect(idleHintIds("lg", true)).toEqual(["commands", "cut-draft", "clear-draft", "thinking", "output"]);
  });

  it("maps widths to the densities the hint rows are built for", () => {
    expect(statusDensityForWidth(40)).toBe("xs");
    expect(statusDensityForWidth(100)).toBe("lg");
  });

  it("bounds the cwd rail by density and enables horizontal scrolling", () => {
    expect(cwdViewportWidth(40, "xs")).toBe(0);
    expect(cwdViewportWidth(60, "sm")).toBe(12);
    expect(cwdViewportWidth(80, "md")).toBe(22);
    expect(cwdViewportWidth(120, "lg")).toBe(33);
    expect(cwdViewportWidth(240, "lg")).toBe(36);
    expect(cwdViewportWidth(240, "lg", 14)).toBe(14);
    expect(cwdViewportWidth(240, "lg", 4)).toBe(4);
    expect(cwdViewportWidth(240, "lg", 100)).toBe(36);

    const statusLine = readFileSync(STATUS_LINE, "utf8");
    expect(statusLine).toContain("<CwdViewport");
    expect(statusLine).toContain("scrollX");
    expect(statusLine).toContain("scrollbox.scrollLeft + dx");
    expect(statusLine).toContain('overflow: "hidden"');
  });

  it("shows context from the initial zero-token state", () => {
    expect(
      contextChipForDensity(
        {
          contextTokens: 0,
          contextLimit: 0,
          lastCompletionTokens: 0,
          sessionPromptTokens: 0,
          sessionCompletionTokens: 0,
          exact: false,
        },
        "lg",
      ),
    ).toBe("ctx 0");
  });

  it("shows only the raw count without an override and the explicit window when set", () => {
    const usage = {
      contextTokens: 54_000,
      contextLimit: 0,
      lastCompletionTokens: 80,
      sessionPromptTokens: 54_000,
      sessionCompletionTokens: 80,
      exact: true,
    };
    for (const density of DENSITIES) {
      expect(contextChipForDensity(usage, density)).toBe("ctx 54k");
      expect(
        contextChipForDensity({ ...usage, contextLimit: 1_000_000 }, density),
      ).toBe("ctx 54k/1M");
    }
  });

  it("accepts human-friendly session context limits", () => {
    expect(parseContextLimitInput("1m")).toBe(1_000_000);
    expect(parseContextLimitInput("253k")).toBe(253_000);
    expect(parseContextLimitInput("250000")).toBe(250_000);
    expect(parseContextLimitInput("")).toBeUndefined();
    expect(parseContextLimitInput("12k")).toBeNull();
  });

  it("routes clicks through the same arm/confirm path as Esc", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    expect(statusLine).toContain("onClick={onRequestCancel}");
    expect(statusLine).not.toContain("void session.cancelAll()");

    const app = readFileSync(APP, "utf8");
    expect(app).toContain("cancelArmed={escapeCancelArmed}");
    expect(app).toContain("onRequestCancel={() => handleEscapeCancellation(false)}");
    expect(app).toContain("}, ESC_CANCEL_WINDOW_MS)");
  });

  it("uses fixed separators without reserved hover width or idle cancel chrome", () => {
    const statusLine = readFileSync(STATUS_LINE, "utf8");
    const idleBranch = statusLine.split("// ── Idle")[1] ?? "";
    expect(statusLine).not.toContain("padEnd(hintWidth");
    expect(statusLine).toContain('content=" │ "');
    expect(statusLine).not.toContain('content="  "');
    expect(idleBranch).not.toContain('"esc: cancel"');
  });
});
