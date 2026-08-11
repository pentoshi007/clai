import { describe, expect, it } from "vitest";
import {
  countComposerVisualLines,
  maxComposerTextRows,
  resolveComposerTextRows,
} from "../../../src/ui-core/composer/composer-height.js";
import {
  composerDraftOverflows,
  composerOwnsWheel,
  measureComposerLines,
  nextComposerScrollOffset,
  resolveComposerWheelTarget,
  tryScrollComposerDraft,
  wheelChatDelta,
} from "../../../src/tui-v2/composer/composer-wheel.js";

describe("countComposerVisualLines", () => {
  it("returns 1 for empty input", () => {
    expect(countComposerVisualLines("", 80)).toBe(1);
  });

  it("counts Shift+Enter hard newlines", () => {
    expect(countComposerVisualLines("hello\nworld\n!", 80)).toBe(3);
  });

  it("soft-wraps long single lines to multiple rows", () => {
    expect(countComposerVisualLines("a".repeat(20), 8)).toBeGreaterThan(1);
  });

  it("combines newlines and width wrap", () => {
    const text = `${"a".repeat(10)}\nshort`;
    expect(countComposerVisualLines(text, 5)).toBeGreaterThan(2);
  });
});

describe("resolveComposerTextRows", () => {
  it("stays at 1 when content is a single line", () => {
    expect(resolveComposerTextRows(1, 16)).toBe(1);
  });

  it("grows with content up to the max budget", () => {
    expect(resolveComposerTextRows(4, 16)).toBe(4);
    expect(resolveComposerTextRows(20, 16)).toBe(16);
  });

  it("never drops below minRows", () => {
    expect(resolveComposerTextRows(0, 8)).toBe(1);
  });
});

describe("composer wheel / draft scroll", () => {
  it("detects when the draft is taller than the visible textarea", () => {
    expect(composerDraftOverflows(20, 12)).toBe(true);
    expect(composerDraftOverflows(8, 12)).toBe(false);
    expect(composerDraftOverflows(12, 12)).toBe(false);
  });

  it("treats any multi-line draft as owning the wheel", () => {
    expect(composerOwnsWheel(1)).toBe(false);
    expect(composerOwnsWheel(2)).toBe(true);
    expect(composerOwnsWheel(40)).toBe(true);
  });

  it("scrolls the draft viewport without overflowing bounds", () => {
    expect(
      nextComposerScrollOffset({
        offsetY: 0,
        viewportHeight: 10,
        totalLines: 40,
        direction: "down",
        delta: 1,
      }),
    ).toBe(3);
    expect(
      nextComposerScrollOffset({
        offsetY: 5,
        viewportHeight: 10,
        totalLines: 40,
        direction: "up",
        delta: 1,
      }),
    ).toBe(2);
    expect(
      nextComposerScrollOffset({
        offsetY: 28,
        viewportHeight: 10,
        totalLines: 40,
        direction: "down",
        delta: 5,
      }),
    ).toBe(30);
    expect(
      nextComposerScrollOffset({
        offsetY: 0,
        viewportHeight: 10,
        totalLines: 8,
        direction: "down",
      }),
    ).toBeUndefined();
  });

  it("consumes wheel for multi-line drafts even when fully visible", () => {
    let downs = 0;
    const editor = {
      lineCount: 5,
      virtualLineCount: 5,
      plainText: "a\nb\nc\nd\ne",
      editorView: {
        getViewport: () => ({ offsetY: 0, offsetX: 0, height: 10, width: 80 }),
        getTotalVirtualLineCount: () => 5,
        setViewport: () => {},
      },
      moveCursorUp: () => {},
      moveCursorDown: () => {
        downs += 1;
      },
    };
    // 5 lines fit in 10 rows — still own the wheel so chat does not move.
    expect(
      tryScrollComposerDraft(editor, {
        contentLines: 5,
        visibleRows: 10,
        direction: "down",
        delta: 1,
      }),
    ).toBe(true);
    expect(downs).toBe(3);
    expect(measureComposerLines(editor, 1)).toBe(5);
  });

  it("routes wheel by focus: unfocused never owns draft", () => {
    const multi = {
      lineCount: 10,
      virtualLineCount: 10,
      plainText: "a\n".repeat(10),
      editorView: {
        getViewport: () => ({ offsetY: 0, offsetX: 0, height: 5, width: 80 }),
        getTotalVirtualLineCount: () => 10,
        setViewport: () => {},
      },
      moveCursorUp: () => {},
      moveCursorDown: () => {},
    };
    expect(
      resolveComposerWheelTarget({
        composerFocused: false,
        editor: multi,
        contentLines: 10,
        visibleRows: 5,
      }),
    ).toBe("chat");
    expect(
      resolveComposerWheelTarget({
        composerFocused: true,
        editor: multi,
        contentLines: 10,
        visibleRows: 5,
      }),
    ).toBe("draft");
    expect(wheelChatDelta("down", 1)).toBe(3);
    expect(wheelChatDelta("up", 1)).toBe(-3);
  });

  it("scrolls overflowing draft viewport and leaves single-line to chat", () => {
    let setY: number | undefined;
    const overflowing = {
      virtualLineCount: 40,
      lineCount: 40,
      plainText: "x\n".repeat(40),
      editorView: {
        getViewport: () => ({ offsetY: 0, offsetX: 0, height: 10, width: 80 }),
        getTotalVirtualLineCount: () => 40,
        setViewport: (_x: number, y: number) => {
          setY = y;
        },
      },
      moveCursorUp: () => {},
      moveCursorDown: () => {},
    };
    expect(
      tryScrollComposerDraft(overflowing, {
        contentLines: 40,
        visibleRows: 10,
        direction: "down",
        delta: 1,
      }),
    ).toBe(true);
    expect(setY).toBe(3);

    const single = {
      lineCount: 1,
      virtualLineCount: 1,
      plainText: "hello",
      editorView: {
        getViewport: () => ({ offsetY: 0, offsetX: 0, height: 1, width: 80 }),
        getTotalVirtualLineCount: () => 1,
        setViewport: () => {},
      },
      moveCursorUp: () => {},
      moveCursorDown: () => {},
    };
    expect(
      tryScrollComposerDraft(single, {
        contentLines: 1,
        visibleRows: 10,
        direction: "down",
      }),
    ).toBe(false);
  });
});

describe("maxComposerTextRows", () => {
  it("leaves room for status, chat floor, and border chrome", () => {
    // 40 term - 1 status - 6 chat - 2 borders = 31, capped at 16
    expect(
      maxComposerTextRows({
        terminalRows: 40,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(16);
  });

  it("shrinks on short terminals", () => {
    expect(
      maxComposerTextRows({
        terminalRows: 12,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(3); // 12 - 1 - 6 - 2
  });

  it("never returns less than 1", () => {
    expect(
      maxComposerTextRows({
        terminalRows: 4,
        statusHeight: 1,
        minChatRows: 6,
        maxCap: 16,
      }),
    ).toBe(1);
  });
});
