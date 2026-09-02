
import {
  TOAST_ENTER_MS,
  TOAST_EXIT_MS,
} from "../../../ui-core/controllers/toast-controller.js";
import { easeInCubic, easeOutCubic } from "../../../ui-core/motion/ease.js";


export const TOAST_BOX_HEIGHT = 3;

export const TOAST_REST_TOP = 1;

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
