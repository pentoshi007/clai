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
}

const defaultSchedule: RepaintScheduler = (run) => {
  const timer = setTimeout(run, RESIZE_COALESCE_MS);
  timer.unref?.();
  return () => clearTimeout(timer);
};

export function installResizeRepaint(options: ResizeRepaintOptions): () => void {
  if (options.enabled === false) return () => {};
  const schedule = options.schedule ?? defaultSchedule;
  let active = true;
  let cancelPending: (() => void) | undefined;

  const flush = (): void => {
    cancelPending = undefined;
    if (!active || options.isSuspended?.() === true) return;
    options.write(RESIZE_REPAINT_SEQUENCE);
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
