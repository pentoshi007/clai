export interface FullRepaintRenderer {
  requestRender(): void;
  readonly isDestroyed?: boolean | undefined;
}

export function forceFullRepaint(renderer: FullRepaintRenderer): boolean {
  try {
    if (renderer.isDestroyed) return false;
    const repaint = Object.getOwnPropertyDescriptor(
      renderer,
      "forceFullRepaintRequested",
    );
    if (typeof repaint?.value !== "boolean" || repaint.writable !== true) {
      return false;
    }
    const nativeRenderer = renderer as FullRepaintRenderer & {
      forceFullRepaintRequested: boolean;
    };
    nativeRenderer.forceFullRepaintRequested = true;
    renderer.requestRender();
    return true;
  } catch {
    return false;
  }
}

export interface AttachedScreenRepaintOptions {
  readonly renderer: FullRepaintRenderer;
  readonly enabled?: boolean | undefined;
  readonly isSuspended?: (() => boolean) | undefined;
}

export function repaintAttachedScreen(
  options: AttachedScreenRepaintOptions,
): boolean {
  if (options.enabled === false || options.isSuspended?.() === true) return false;
  return forceFullRepaint(options.renderer);
}
