import { describe, expect, it } from "vitest";
import { StyledText, stringToStyledText } from "@opentui/core";
import {
  patchOpenTuiTextContent,
  sanitizeOpenTuiTextContent,
} from "../src/tui-v2/bootstrap/patch-opentui-text.js";

describe("patchOpenTuiTextContent", () => {
  it("is idempotent and exports a callable patch", () => {
    expect(() => {
      patchOpenTuiTextContent();
      patchOpenTuiTextContent();
    }).not.toThrow();
  });

  it("StyledText with chunks remains valid for content assignment", () => {
    const st = stringToStyledText("hello");
    expect(st.chunks?.length).toBeGreaterThan(0);
    const emptyish = new StyledText([]);
    expect(Array.isArray(emptyish.chunks)).toBe(true);
  });

  it("removes controls from plain strings at the renderer boundary", () => {
    expect(sanitizeOpenTuiTextContent("\x1b\x1bError\x1b: timed out")).toBe(
      "rror: timed out",
    );
    expect(sanitizeOpenTuiTextContent("\x1b")).toBe(" ");
  });

  it("removes controls from StyledText chunks without flattening safe styles", () => {
    const safe = stringToStyledText("safe");
    expect(sanitizeOpenTuiTextContent(safe)).toBe(safe);

    const dirty = stringToStyledText("\x1b]0;title\x07safe\x1b:");
    const sanitized = sanitizeOpenTuiTextContent(dirty);
    expect(sanitized).toBeInstanceOf(StyledText);
    expect((sanitized as StyledText).chunks.map((chunk) => chunk.text).join(""))
      .toBe("safe:");
  });
});
