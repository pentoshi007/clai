import { RESET_VISIBLE_SCREEN } from "../../os/screen-sequences.js";

export const RESIZE_REPAINT_SEQUENCE = RESET_VISIBLE_SCREEN;

export type ResizeListener = (width: number, height: number) => void;

export interface ResizeRepaintRenderer {
  on(event: "resize", listener: ResizeListener): unknown;
  off(event: "resize", listener: ResizeListener): unknown;
}

export interface ResizeRepaintOptions {
  readonly renderer: ResizeRepaintRenderer;
  readonly write: (text: string) => void;
  readonly enabled?: boolean | undefined;
  readonly isSuspended?: (() => boolean) | undefined;
  readonly onApplied?: (() => void) | undefined;
}

export function installResizeRepaint(options: ResizeRepaintOptions): () => void {
  if (options.enabled === false) return () => {};
  let active = true;
  const onResize: ResizeListener = () => {
    if (!active || options.isSuspended?.() === true) return;
    options.write(RESIZE_REPAINT_SEQUENCE);
    options.onApplied?.();
  };
  options.renderer.on("resize", onResize);
  return () => {
    if (!active) return;
    active = false;
    options.renderer.off("resize", onResize);
  };
}
