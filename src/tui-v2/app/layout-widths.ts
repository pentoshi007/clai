import {
  PLAN_MAX_WIDTH,
  PLAN_MIN_WIDTH,
  PLAN_OVERLAY_SHARE,
  type PlanPlacement,
} from "../../ui-core/layout/compute-layout.js";

const PREFERRED_CHAT_WIDTH = 24;
const MIN_OVERLAY_COLS = 48;
const PLAN_CHAT_GAP = 1;
const APP_HORIZONTAL_PADDING = 0;

export interface AppWidthBudgetInput {
  readonly terminalWidth: number;
  readonly planPresent: boolean;
  readonly planPlacement: PlanPlacement;
  readonly requestedSplitPlanWidth: number;
}

export interface AppWidthBudget {
  readonly terminalWidth: number;
  readonly horizontalPadding: number;
  readonly contentInnerWidth: number;
  readonly planChatGap: number;
  readonly splitPlanWidth: number;
  readonly overlayPlanWidth: number;
  readonly overlayReserveWidth: number;
  readonly chatContentWidth: number;
  readonly transcriptContentWidth: number;
  readonly showPlanOverlay: boolean;
}

function boundedInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function appWidthBudget(input: AppWidthBudgetInput): AppWidthBudget {
  const terminalWidth = boundedInteger(input.terminalWidth);
  const horizontalPadding = APP_HORIZONTAL_PADDING;
  const contentInnerWidth = Math.max(0, terminalWidth - horizontalPadding * 2);
  const preferredChatWidth = Math.min(PREFERRED_CHAT_WIDTH, contentInnerWidth);

  let planChatGap = 0;
  let splitPlanWidth = 0;
  let overlayPlanWidth = 0;
  let overlayReserveWidth = 0;

  if (input.planPresent && input.planPlacement === "split") {
    const availableForPlan = Math.max(0, contentInnerWidth - preferredChatWidth);
    splitPlanWidth = Math.min(
      boundedInteger(input.requestedSplitPlanWidth),
      availableForPlan,
    );
    if (splitPlanWidth > 0) planChatGap = Math.min(PLAN_CHAT_GAP, preferredChatWidth);
  } else if (
    input.planPresent &&
    input.planPlacement === "overlay" &&
    contentInnerWidth >= MIN_OVERLAY_COLS
  ) {
    overlayPlanWidth = Math.min(
      PLAN_MAX_WIDTH,
      Math.max(PLAN_MIN_WIDTH, Math.floor(terminalWidth * PLAN_OVERLAY_SHARE) - 1),
    );
    const availableForPlan = contentInnerWidth - preferredChatWidth - PLAN_CHAT_GAP;
    if (availableForPlan >= PLAN_MIN_WIDTH) {
      overlayPlanWidth = Math.min(overlayPlanWidth, availableForPlan);
      overlayReserveWidth = overlayPlanWidth;
      planChatGap = PLAN_CHAT_GAP;
    }
  }

  const chatContentWidth = Math.max(
    0,
    contentInnerWidth - splitPlanWidth - overlayReserveWidth,
  );
  const transcriptContentWidth = Math.max(0, chatContentWidth - planChatGap);

  return {
    terminalWidth,
    horizontalPadding,
    contentInnerWidth,
    planChatGap,
    splitPlanWidth,
    overlayPlanWidth,
    overlayReserveWidth,
    chatContentWidth,
    transcriptContentWidth,
    showPlanOverlay: overlayPlanWidth > 0,
  };
}

export function focusAfterPlanSuppression(
  focusContext: string,
  planRendered: boolean,
): "transcript" | undefined {
  return focusContext === "plan" && !planRendered ? "transcript" : undefined;
}
