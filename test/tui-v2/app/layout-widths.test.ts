import { describe, expect, it } from "vitest";
import {
  appWidthBudget,
  focusAfterPlanSuppression,
} from "../../../src/tui-v2/app/layout-widths.js";
import type { PlanPlacement } from "../../../src/ui-core/layout/compute-layout.js";

const WIDTHS = [0, 1, 9, 19, 20, 23, 24, 27, 28, 55, 56, 59, 60, 100, 119, 120];
const PLACEMENTS: PlanPlacement[] = ["hidden", "overlay", "split"];

describe("OpenTUI App width budget", () => {
  it("keeps every child width inside the terminal and content parent", () => {
    for (const terminalWidth of WIDTHS) {
      for (const planPlacement of PLACEMENTS) {
        const budget = appWidthBudget({
          terminalWidth,
          planPresent: planPlacement !== "hidden",
          planPlacement,
          requestedSplitPlanWidth: 52,
        });

        expect(budget.terminalWidth).toBe(Math.max(0, terminalWidth));
        expect(
          budget.horizontalPadding * 2 + budget.contentInnerWidth,
        ).toBeLessThanOrEqual(budget.terminalWidth);
        expect(budget.chatContentWidth).toBeGreaterThanOrEqual(0);
        expect(budget.chatContentWidth).toBeLessThanOrEqual(
          budget.contentInnerWidth,
        );
        expect(budget.transcriptContentWidth).toBeGreaterThanOrEqual(0);
        expect(budget.transcriptContentWidth).toBeLessThanOrEqual(
          budget.chatContentWidth,
        );
        expect(
          budget.chatContentWidth +
            budget.splitPlanWidth +
            budget.overlayReserveWidth,
        ).toBeLessThanOrEqual(budget.contentInnerWidth);
        expect(budget.overlayPlanWidth).toBeLessThanOrEqual(
          budget.contentInnerWidth,
        );
      }
    }
  });

  it("suppresses an overlay that cannot coexist with usable chat", () => {
    const narrow = appWidthBudget({
      terminalWidth: 20,
      planPresent: true,
      planPlacement: "overlay",
      requestedSplitPlanWidth: 0,
    });
    expect(narrow.showPlanOverlay).toBe(false);
    expect(narrow.overlayPlanWidth).toBe(0);
    expect(narrow.chatContentWidth).toBe(20);

    const usable = appWidthBudget({
      terminalWidth: 64,
      planPresent: true,
      planPlacement: "overlay",
      requestedSplitPlanWidth: 0,
    });
    expect(usable.showPlanOverlay).toBe(true);
    expect(usable.overlayPlanWidth).toBe(34);
    expect(usable.chatContentWidth).toBe(24);
  });

  it("moves focus away from a plan hidden by a narrow resize", () => {
    expect(focusAfterPlanSuppression("plan", false)).toBe("transcript");
    expect(focusAfterPlanSuppression("plan", true)).toBeUndefined();
    expect(focusAfterPlanSuppression("composer", false)).toBeUndefined();
  });

  it("restores normal budgets after tiny transitional frames", () => {
    const transition = [0, 20, 100, 20, 100].map((terminalWidth) =>
      appWidthBudget({
        terminalWidth,
        planPresent: true,
        planPlacement: "overlay",
        requestedSplitPlanWidth: 0,
      }),
    );

    expect(transition[0]?.chatContentWidth).toBe(0);
    expect(transition[1]?.chatContentWidth).toBe(20);
    expect(transition[2]).toMatchObject({
      contentInnerWidth: 96,
      overlayPlanWidth: 40,
      overlayReserveWidth: 42,
      chatContentWidth: 54,
      transcriptContentWidth: 52,
    });
    expect(transition[3]?.chatContentWidth).toBe(20);
    expect(transition[4]).toEqual(transition[2]);
  });
});
