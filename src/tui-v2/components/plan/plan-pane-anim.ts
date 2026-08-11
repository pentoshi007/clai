/**
 * Pure task-pane motion math — snappy enter/exit (faster than toasts).
 *
 * Open:  slide in (~120ms ease-out)
 * Close: slide out (~100ms ease-in), then unmount
 */

import { easeInCubic, easeOutCubic, clamp01 } from "../../../ui-core/motion/ease.js";

/** Slide-in duration — a bit snappier than toast (200ms). */
export const PLAN_PANE_ENTER_MS = 120;
/** Slide-out duration — slightly faster than enter so hide feels instant. */
export const PLAN_PANE_EXIT_MS = 100;

export type PaneAnimPhase = "enter" | "open" | "exit" | "closed";

export interface PaneAnimState {
  readonly phase: PaneAnimPhase;
  /** 0 = fully hidden, 1 = fully shown. */
  readonly progress: number;
  /** Keep the pane in the tree during enter/open/exit. */
  readonly mounted: boolean;
}

/**
 * Progress for a known phase + age within that phase.
 */
export function paneProgress(
  phase: PaneAnimPhase,
  ageMs: number,
  enterMs: number = PLAN_PANE_ENTER_MS,
  exitMs: number = PLAN_PANE_EXIT_MS,
): number {
  const age = Math.max(0, ageMs);
  switch (phase) {
    case "closed":
      return 0;
    case "open":
      return 1;
    case "enter":
      return easeOutCubic(clamp01(age / Math.max(1, enterMs)));
    case "exit":
      return 1 - easeInCubic(clamp01(age / Math.max(1, exitMs)));
    default:
      return 0;
  }
}

export function paneMounted(phase: PaneAnimPhase): boolean {
  return phase !== "closed";
}

/**
 * Overlay placement: slide from above the viewport to restTop.
 * @param progress 0..1 visibility
 * @param restTop resting top row when fully open
 * @param paneHeight box height (for off-screen start)
 */
export function paneSlideTop(
  progress: number,
  restTop: number,
  paneHeight: number,
): number {
  const p = clamp01(progress);
  const hiddenTop = -Math.max(1, paneHeight);
  return Math.round(hiddenTop + (restTop - hiddenTop) * p);
}

/**
 * Split placement: grow/shrink width with progress.
 */
export function paneSlideWidth(progress: number, fullWidth: number): number {
  const p = clamp01(progress);
  if (p <= 0) return 0;
  return Math.max(1, Math.round(fullWidth * p));
}

/**
 * Whether the enter/exit phase has finished and should advance.
 */
export function panePhaseComplete(
  phase: PaneAnimPhase,
  ageMs: number,
  enterMs: number = PLAN_PANE_ENTER_MS,
  exitMs: number = PLAN_PANE_EXIT_MS,
): PaneAnimPhase | null {
  const age = Math.max(0, ageMs);
  if (phase === "enter" && age >= enterMs) return "open";
  if (phase === "exit" && age >= exitMs) return "closed";
  return null;
}
