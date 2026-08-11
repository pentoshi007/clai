/**
 * Pure toast motion math — slide in from top-center, hold, slide out.
 * Terminal UIs animate by discrete row steps; ease curves keep it smooth-ish.
 */

import {
  TOAST_ENTER_MS,
  TOAST_EXIT_MS,
} from "../../../ui-core/controllers/toast-controller.js";
import { easeInCubic, easeOutCubic } from "../../../ui-core/motion/ease.js";


/**
 * Minimum toast chip height (pad + one body line + pad).
 * Multi-line wraps use a taller box; pass `boxHeight` into toastAnimAt.
 */
export const TOAST_BOX_HEIGHT = 3;

/** Resting top row when fully visible (1 = just under terminal top edge). */
export const TOAST_REST_TOP = 1;

/** Off-screen top when fully hidden above the viewport (min height). */
export const TOAST_HIDDEN_TOP = -TOAST_BOX_HEIGHT;

export type ToastAnimPhase = "enter" | "hold" | "exit" | "gone";

export interface ToastAnimState {
  readonly phase: ToastAnimPhase;
  /** Absolute top row for absolute positioning. */
  readonly top: number;
  /**
   * 0..1 visibility for optional dimming (1 = fully shown).
   * Terminal cannot fade alpha; host may map low values to DIM.
   */
  readonly visibility: number;
}

/**
 * Compute motion for a toast at `ageMs` since createdAt.
 * @param holdMs time at rest (item.durationMs)
 * @param boxHeight rendered height (pad + wrapped body lines); default min chip
 */
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
