import { describe, expect, it } from "vitest";
import {
  clampCompletionViewport,
  completionAbsoluteIndex,
  completionViewportWindow,
  completionVisibleCount,
  completionWheelRows,
  initialCompletionViewportState,
  keepCompletionSelectionVisible,
  reduceCompletionViewport,
} from "../../../src/ui-core/composer/completion-viewport.js";

const bounds = { itemCount: 25, maxRows: 10 } as const;

describe("completion viewport", () => {
  it("clamps viewport offsets and visible rows at every boundary", () => {
    expect(completionVisibleCount(0, 10)).toBe(0);
    expect(completionVisibleCount(25, 10)).toBe(10);
    expect(completionVisibleCount(3, 10)).toBe(3);
    expect(clampCompletionViewport(-5, 25, 10)).toBe(0);
    expect(clampCompletionViewport(7, 25, 10)).toBe(7);
    expect(clampCompletionViewport(99, 25, 10)).toBe(15);
    expect(clampCompletionViewport(4, 3, 10)).toBe(0);
  });

  it("maps wheel direction to deliberate row movement without changing selection", () => {
    expect(completionWheelRows("up", 2.2)).toBe(-3);
    expect(completionWheelRows("down", 2.2)).toBe(3);
    expect(completionWheelRows("left", 0)).toBe(-1);
    expect(completionWheelRows("right", 0)).toBe(1);
    expect(completionWheelRows("unknown", 5)).toBe(0);

    const initial = initialCompletionViewportState();
    const scrolled = reduceCompletionViewport(
      initial,
      { type: "scroll", rows: 7 },
      bounds,
    );
    expect(scrolled).toEqual({ offset: 7, selected: 0, hovered: undefined });
  });

  it("changes hover styling state without moving keyboard selection or viewport", () => {
    const state = { offset: 8, selected: 3, hovered: undefined };
    expect(
      reduceCompletionViewport(state, { type: "hover", index: 12 }, bounds),
    ).toEqual({ offset: 8, selected: 3, hovered: 12 });
    expect(
      reduceCompletionViewport(
        { offset: 8, selected: 3, hovered: 12 },
        { type: "hover", index: undefined },
        bounds,
      ),
    ).toEqual({ offset: 8, selected: 3, hovered: undefined });
  });

  it("moves the viewport only as needed to keep keyboard selection visible", () => {
    expect(keepCompletionSelectionVisible(5, 5, 25, 10)).toBe(5);
    expect(keepCompletionSelectionVisible(5, 14, 25, 10)).toBe(5);
    expect(keepCompletionSelectionVisible(5, 15, 25, 10)).toBe(6);
    expect(keepCompletionSelectionVisible(5, 3, 25, 10)).toBe(3);

    const moved = reduceCompletionViewport(
      { offset: 5, selected: 14, hovered: 11 },
      { type: "select", index: 15 },
      bounds,
    );
    expect(moved).toEqual({ offset: 6, selected: 15, hovered: undefined });
  });

  it("reaches middle and final windows through repeated wheel scrolling", () => {
    let state = initialCompletionViewportState();
    state = reduceCompletionViewport(state, { type: "scroll", rows: 7 }, bounds);
    expect(completionViewportWindow(25, 10, state.offset)).toEqual({
      start: 7,
      end: 17,
      visibleCount: 10,
      before: 7,
      after: 8,
    });
    state = reduceCompletionViewport(state, { type: "scroll", rows: 100 }, bounds);
    expect(state.offset).toBe(15);
    expect(completionViewportWindow(25, 10, state.offset).end).toBe(25);
  });

  it("keeps click indexes absolute and stable for a scrolled window", () => {
    expect(completionAbsoluteIndex(25, 10, 7, 0)).toBe(7);
    expect(completionAbsoluteIndex(25, 10, 7, 5)).toBe(12);
    expect(completionAbsoluteIndex(25, 10, 7, 9)).toBe(16);
    expect(completionAbsoluteIndex(25, 10, 7, 10)).toBeUndefined();
  });

  it("reconciles selection and viewport when filtering shrinks the list", () => {
    const state = { offset: 15, selected: 24, hovered: 22 };
    expect(
      reduceCompletionViewport(
        state,
        { type: "reconcile", selected: 4 },
        { itemCount: 6, maxRows: 10 },
      ),
    ).toEqual({ offset: 0, selected: 4, hovered: undefined });
  });
});
