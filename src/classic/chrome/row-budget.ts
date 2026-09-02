import { COMPOSER_MAX_HEIGHT } from "../../ui-core/layout/compute-layout.js";
import type { OverlayContext } from "../../ui-core/controllers/focus-controller.js";

export const COMPOSER_MAX_TEXT_ROWS = COMPOSER_MAX_HEIGHT;
export const COMPOSER_BORDER_ROWS = 2;
export const COMPOSER_DIR_ROWS = 1;
export const COMPOSER_GAP_ROWS = 1;
export const OVERLAY_MIN_ROWS = 5;
export const MAX_TOAST_ROWS = 2;
export const QUEUE_MAX_ROWS = 5;
export const PLAN_MIN_ROWS = 5;
export const PLAN_MAX_ROWS = 14;
export const PLAN_BORDER_ROWS = 2;

export type StatusRowsWanted = 1 | 2 | 3;

export interface ChromeOverlayDemand {
  readonly kind: OverlayContext;
  readonly rowsWanted: number;
}

export interface ChromeDemand {
  readonly rows: number;
  readonly columns: number;
  readonly composerTextRows: number;
  readonly statusRowsWanted: StatusRowsWanted;
  readonly toastCount: number;
  readonly queueCount: number;
  readonly responderVisible: boolean;
  readonly planVisible: boolean;
  readonly planRowsWanted: number;
  readonly overlay: ChromeOverlayDemand | undefined;
}

export interface ChromeLayout {
  readonly composer: number;
  readonly status: number;
  readonly toast: number;
  readonly queue: number;
  readonly responder: number;
  readonly plan: number;
  readonly overlay: number;
  readonly liveTail: number;
  readonly total: number;
  readonly degraded: boolean;
}

function clamp(value: number, lower: number, ...uppers: readonly number[]): number {
  return Math.max(0, Math.min(Math.max(value, lower), ...uppers));
}

function whole(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function allocateChrome(demand: ChromeDemand): ChromeLayout {
  const rows = whole(demand.rows);
  let budget = rows;

  const composerCap = Math.min(COMPOSER_MAX_TEXT_ROWS, Math.floor(rows * 0.4));
  const composerBox =
    COMPOSER_DIR_ROWS +
    COMPOSER_BORDER_ROWS +
    clamp(whole(demand.composerTextRows), 1, composerCap);
  let composer =
    composerBox + COMPOSER_GAP_ROWS + 2 <= budget
      ? composerBox + COMPOSER_GAP_ROWS
      : composerBox;
  if (composer > budget)
    composer = Math.min(COMPOSER_GAP_ROWS + COMPOSER_DIR_ROWS + COMPOSER_BORDER_ROWS + 1, budget);
  budget -= composer;

  let status = Math.min(1, budget);
  budget -= status;

  const overlayWanted = demand.overlay ? whole(demand.overlay.rowsWanted) : 0;
  const overlay = demand.overlay
    ? clamp(overlayWanted, OVERLAY_MIN_ROWS, Math.floor(rows * 0.6), budget)
    : 0;
  budget -= overlay;

  const toast = Math.min(whole(demand.toastCount), MAX_TOAST_ROWS, budget);
  budget -= toast;

  const queueCount = whole(demand.queueCount);
  const queue = queueCount > 0 ? Math.min(queueCount + 1, QUEUE_MAX_ROWS, budget) : 0;
  budget -= queue;

  const responder = demand.responderVisible ? Math.min(1, budget) : 0;
  budget -= responder;

  const plan = demand.planVisible
    ? clamp(
        whole(demand.planRowsWanted) + PLAN_BORDER_ROWS,
        PLAN_MIN_ROWS,
        PLAN_MAX_ROWS,
        budget,
      )
    : 0;
  budget -= plan;

  const statusExtra = Math.min(demand.statusRowsWanted - status, budget);
  status += Math.max(0, statusExtra);
  budget -= Math.max(0, statusExtra);

  const liveTail = budget;
  const total = composer + status + toast + queue + responder + plan + overlay + liveTail;

  return {
    composer,
    status,
    toast,
    queue,
    responder,
    plan,
    overlay,
    liveTail,
    total,
    degraded:
      status < demand.statusRowsWanted ||
      (overlay > 0 && overlay < overlayWanted) ||
      (demand.planVisible && plan === 0) ||
      liveTail === 0,
  };
}
