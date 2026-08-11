import { describe, expect, it } from "vitest";
import {
  TOAST_BOX_HEIGHT,
  TOAST_HIDDEN_TOP,
  TOAST_REST_TOP,
  toastAnimAt,
} from "../../src/tui-v2/components/toast/toast-anim.js";
import { easeInCubic, easeOutCubic } from "../../src/ui-core/motion/ease.js";
import {
  TOAST_ENTER_MS,
  TOAST_EXIT_MS,
  toastTotalLifetimeMs,
} from "../../src/ui-core/controllers/toast-controller.js";

describe("toast animation", () => {
  it("starts fully above the viewport and settles at rest top", () => {
    const start = toastAnimAt(0, 2000);
    expect(start.phase).toBe("enter");
    expect(start.top).toBe(TOAST_HIDDEN_TOP);
    expect(start.visibility).toBe(0);

    // Early enter: still moving (use 25% so discrete row rounding doesn't
    // snap a tall ease-out midpoint onto the rest row).
    const early = toastAnimAt(TOAST_ENTER_MS * 0.25, 2000);
    expect(early.phase).toBe("enter");
    expect(early.top).toBeGreaterThanOrEqual(TOAST_HIDDEN_TOP);
    expect(early.top).toBeLessThanOrEqual(TOAST_REST_TOP);
    expect(early.visibility).toBeGreaterThan(0);
    expect(early.visibility).toBeLessThan(1);

    const hold = toastAnimAt(TOAST_ENTER_MS + 100, 2000);
    expect(hold.phase).toBe("hold");
    expect(hold.top).toBe(TOAST_REST_TOP);
    expect(hold.visibility).toBe(1);
  });

  it("slides back up during exit after the hold", () => {
    const holdMs = 2000;
    const exitStart = TOAST_ENTER_MS + holdMs;
    // Late exit so ease-in has moved enough rows after Math.round.
    const lateExit = toastAnimAt(exitStart + TOAST_EXIT_MS * 0.85, holdMs);
    expect(lateExit.phase).toBe("exit");
    expect(lateExit.top).toBeLessThan(TOAST_REST_TOP);
    expect(lateExit.visibility).toBeLessThan(1);

    const gone = toastAnimAt(toastTotalLifetimeMs(holdMs) + 1, holdMs);
    expect(gone.phase).toBe("gone");
    expect(gone.top).toBe(TOAST_HIDDEN_TOP);
  });

  it("ease curves stay in 0..1 and ease directions differ", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeInCubic(0)).toBe(0);
    expect(easeInCubic(1)).toBe(1);
    // Out starts faster than linear; in starts slower.
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    expect(easeInCubic(0.5)).toBeLessThan(0.5);
  });

  it("box height matches hidden offset", () => {
    expect(TOAST_HIDDEN_TOP).toBe(-TOAST_BOX_HEIGHT);
  });
});
