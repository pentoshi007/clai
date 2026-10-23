import { describe, expect, it } from "vitest";
import {
  appWidthBudget,
  focusAfterPlanSuppression,
} from "../../../src/tui-v2/app/layout-widths.js";
import { computeLayout, type PlanPlacement } from "../../../src/ui-core/layout/compute-layout.js";

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
    expect(usable.overlayPlanWidth).toBe(33);
    expect(usable.chatContentWidth).toBe(31);
    expect(usable.transcriptContentWidth).toBe(30);
  });

  it.each([
    { terminalWidth: 120, planWidth: 38, transcriptWidth: 81 },
    { terminalWidth: 128, planWidth: 40, transcriptWidth: 87 },
    { terminalWidth: 160, planWidth: 48, transcriptWidth: 111 },
  ])("gives the transcript one extra column at $terminalWidth columns", ({ terminalWidth, planWidth, transcriptWidth }) => {
    const layout = computeLayout({ columns: terminalWidth, rows: 40, planVisible: true, splitEnabled: true });
    const budget = appWidthBudget({
      terminalWidth,
      planPresent: true,
      planPlacement: layout.plan.placement,
      requestedSplitPlanWidth: layout.plan.width,
    });
    expect(budget.splitPlanWidth).toBe(planWidth);
    expect(budget.transcriptContentWidth).toBe(transcriptWidth);
    expect(budget.splitPlanWidth + budget.planChatGap + budget.transcriptContentWidth).toBe(terminalWidth);
  });

  it("preserves the chat floor at the overlay visibility boundary", () => {
    const budget = (terminalWidth: number) => appWidthBudget({
      terminalWidth, planPresent: true, planPlacement: "overlay", requestedSplitPlanWidth: 0,
    });
    expect(budget(57).showPlanOverlay).toBe(false);
    expect(budget(58)).toMatchObject({ showPlanOverlay: true, overlayPlanWidth: 33, transcriptContentWidth: 24 });
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
      contentInnerWidth: 100,
      overlayPlanWidth: 36,
      overlayReserveWidth: 36,
      chatContentWidth: 64,
      transcriptContentWidth: 63,
    });
    expect(transition[3]?.chatContentWidth).toBe(20);
    expect(transition[4]).toEqual(transition[2]);
  });
});
