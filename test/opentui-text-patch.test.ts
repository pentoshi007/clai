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

  it("removes terminal sequences split across independently styled chunks", () => {
    const chunks = [
      ...stringToStyledText("✓ \x1b[").chunks,
      ...stringToStyledText("32mtests\x1b]0;window").chunks,
      ...stringToStyledText(" title\x07 passed\x1b[0m").chunks,
    ];
    const sanitized = sanitizeOpenTuiTextContent(new StyledText(chunks)) as StyledText;
    expect(sanitized.chunks.map((chunk) => chunk.text).join("")).toBe("✓ tests passed");
    expect(chunks.map((chunk) => chunk.text).join("")).toContain("\x1b[32m");
  });

  it("uses a safe placeholder for styled content containing only controls", () => {
    const dirty = new StyledText([
      ...stringToStyledText("\x1b[").chunks,
      ...stringToStyledText("?1049l\x1b[2J").chunks,
    ]);
    expect(sanitizeOpenTuiTextContent(dirty)).toBe(" ");
  });
});
