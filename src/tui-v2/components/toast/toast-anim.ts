
import {
  TOAST_ENTER_MS,
  TOAST_EXIT_MS,
} from "../../../ui-core/controllers/toast-controller.js";
import { easeInCubic, easeOutCubic } from "../../../ui-core/motion/ease.js";


export const TOAST_BOX_HEIGHT = 1;

export const TOAST_REST_TOP = 0;

export const TOAST_HIDDEN_TOP = -TOAST_BOX_HEIGHT;

export type ToastAnimPhase = "enter" | "hold" | "exit" | "gone";

export interface ToastAnimState {
  readonly phase: ToastAnimPhase;
  readonly top: number;
  readonly visibility: number;
}

export function toastAnimAt(
  ageMs: number,
  holdMs: number,
  boxHeight: number = TOAST_BOX_HEIGHT,
): ToastAnimState {
  const age = Math.max(0, ageMs);
  const hold = Math.max(0, holdMs);
  const h = Math.max(TOAST_BOX_HEIGHT, Math.floor(boxHeight));
  const hiddenTop = -h;
  const enterEnd = TOAST_ENTER_MS;
  const holdEnd = enterEnd + hold;
  const exitEnd = holdEnd + TOAST_EXIT_MS;

  if (age < enterEnd) {
    const p = easeOutCubic(age / Math.max(1, TOAST_ENTER_MS));
    const top = Math.round(hiddenTop + (TOAST_REST_TOP - hiddenTop) * p);
    return { phase: "enter", top, visibility: p };
  }
  if (age < holdEnd) {
    return { phase: "hold", top: TOAST_REST_TOP, visibility: 1 };
  }
  if (age < exitEnd) {
    const p = easeInCubic((age - holdEnd) / Math.max(1, TOAST_EXIT_MS));
    const top = Math.round(TOAST_REST_TOP + (hiddenTop - TOAST_REST_TOP) * p);
    return { phase: "exit", top, visibility: 1 - p };
  }
  return { phase: "gone", top: hiddenTop, visibility: 0 };
}

export interface ToastTiming {
  readonly createdAt: number;
  readonly durationMs: number;
  readonly sticky?: boolean | undefined;
}

export function nextToastFrameDelay(
  items: readonly ToastTiming[],
  now: number,
  frameMs: number,
): number | undefined {
  let next: number | undefined;
  for (const item of items) {
    const age = Math.max(0, now - item.createdAt);
    const holdEnd = item.sticky ? Number.POSITIVE_INFINITY : TOAST_ENTER_MS + Math.max(0, item.durationMs);
    let wait: number | undefined;
    if (age < TOAST_ENTER_MS) wait = frameMs;
    else if (age < holdEnd) wait = Number.isFinite(holdEnd) ? holdEnd - age : undefined;
    else if (age < holdEnd + TOAST_EXIT_MS) wait = frameMs;
    if (wait !== undefined) next = next === undefined ? wait : Math.min(next, wait);
  }
  return next === undefined ? undefined : Math.max(1, Math.ceil(next));
}
