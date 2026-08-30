import { RESET_VISIBLE_SCREEN } from "../../os/screen-sequences.js";

export const RESIZE_REPAINT_SEQUENCE = RESET_VISIBLE_SCREEN;

export const RESIZE_COALESCE_MS = 16;

export type ResizeListener = (width: number, height: number) => void;

export interface ResizeRepaintRenderer {
  on(event: "resize", listener: ResizeListener): unknown;
  off(event: "resize", listener: ResizeListener): unknown;
}

export type RepaintScheduler = (run: () => void) => () => void;

export interface ResizeRepaintOptions {
  readonly renderer: ResizeRepaintRenderer;
  readonly write: (text: string) => void;
  readonly enabled?: boolean | undefined;
  readonly isSuspended?: (() => boolean) | undefined;
  readonly schedule?: RepaintScheduler | undefined;
  /**
   * Forces the renderer to redraw every cell after the clear.
   *
   * OpenTUI emits `resize` and then calls `requestRender()` itself, so the
   * coalesced clear lands *after* the renderer has already painted the new
   * geometry. The clear wipes that frame, and the renderer will not redraw it
   * because its diff still believes the screen matches its buffer — leaving only
   * the components that repaint on their own (the composer) visible. Pairing the
   * clear with a forced repaint makes the outcome independent of that ordering.
   */
  readonly requestRepaint?: (() => void) | undefined;
}

const defaultSchedule: RepaintScheduler = (run) => {
  const timer = setTimeout(run, RESIZE_COALESCE_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export interface FullRepaintRenderer {
  requestRender(): void;
  readonly currentRenderBuffer?: { clear(): void } | undefined;
}

/**
 * Invalidates the renderer's picture of the screen, then asks for a frame.
 *
 * OpenTUI's native renderer only emits the cells that differ from
 * `currentRenderBuffer`, so `requestRender()` alone is a no-op after we clear the
 * terminal behind its back. Zeroing that buffer first makes every cell differ,
 * which is the same effect as the renderer's internal full-repaint flag (private,
 * and only set on suspend/resume and screen-mode transitions). The buffer clear
 * is best-effort: if the shape ever changes, the plain render request still runs.
 */
export function forceFullRepaint(renderer: FullRepaintRenderer): void {
  try {
    renderer.currentRenderBuffer?.clear();
  } catch {
    /* buffer already torn down — the render request below is still worth making */
  }
  try {
    renderer.requestRender();
  } catch {
    /* renderer is going away; the next mount repaints from scratch */
  }
}

export function installResizeRepaint(options: ResizeRepaintOptions): () => void {
  if (options.enabled === false) return () => {};
  const schedule = options.schedule ?? defaultSchedule;
  let active = true;
  let cancelPending: (() => void) | undefined;

  const flush = (): void => {
    cancelPending = undefined;
    if (!active || options.isSuspended?.() === true) return;
    options.write(RESIZE_REPAINT_SEQUENCE);
    options.requestRepaint?.();
  };
  const onResize: ResizeListener = () => {
    if (!active || options.isSuspended?.() === true) return;
    cancelPending?.();
    cancelPending = schedule(flush);
  };

  options.renderer.on("resize", onResize);
  return () => {
    if (!active) return;
    active = false;
    cancelPending?.();
    cancelPending = undefined;
    options.renderer.off("resize", onResize);
  };
}
