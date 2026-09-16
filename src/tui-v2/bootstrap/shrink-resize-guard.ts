import { writeTerminalDirect } from "../../os/terminal-write.js";
import { forceFullRepaint } from "./resize-repaint.js";

export interface RenderBufferLike {
  clear?(color?: unknown): void;
}

export interface ShrinkResizeRenderer {
  resize(columns: number, rows: number): void;
  requestRender(): void;
  readonly isDestroyed?: boolean | undefined;
  readonly currentRenderBuffer?: RenderBufferLike | undefined;
  readonly nextRenderBuffer?: RenderBufferLike | undefined;
}

export interface ResizeSignalSource {
  on(event: "SIGWINCH", listener: () => void): unknown;
  off(event: "SIGWINCH", listener: () => void): unknown;
}

export interface TerminalSizeSource {
  getWindowSize?(): [number, number] | undefined;
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write?(text: string): unknown;
}

export interface ShrinkResizeGuardOptions {
  readonly renderer: ShrinkResizeRenderer;
  readonly terminal?: TerminalSizeSource | undefined;
  readonly signals?: ResizeSignalSource | undefined;
  readonly settleMs?: number | undefined;
}

interface TerminalSize {
  readonly columns: number;
  readonly rows: number;
}

const DEFAULT_SETTLE_MS = 150;
const CLEAR_SCREEN_SEQUENCE = "\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H";

function readSize(source: TerminalSizeSource): TerminalSize {
  const windowSize = source.getWindowSize?.();
  return {
    columns: windowSize?.[0] ?? source.columns ?? 0,
    rows: windowSize?.[1] ?? source.rows ?? 0,
  };
}

function isShrink(previous: TerminalSize, next: TerminalSize): boolean {
  if (next.columns <= 0 || next.rows <= 0) return false;
  const narrower = previous.columns > 0 && next.columns < previous.columns;
  const shorter = previous.rows > 0 && next.rows < previous.rows;
  return narrower || shorter;
}

function clearScreen(
  renderer: ShrinkResizeRenderer,
  terminal?: TerminalSizeSource,
): void {
  const writeOut = (renderer as unknown as { writeOut?(text: string): unknown })
    .writeOut;
  if (typeof writeOut === "function") {
    writeOut.call(renderer, CLEAR_SCREEN_SEQUENCE);
    return;
  }
  if (typeof terminal?.write === "function") {
    terminal.write(CLEAR_SCREEN_SEQUENCE);
    return;
  }
  writeTerminalDirect(CLEAR_SCREEN_SEQUENCE);
}

function cancelPendingRendererResize(renderer: ShrinkResizeRenderer): void {
  const target = renderer as unknown as {
    resizeTimeoutId?: unknown;
    clock?: { clearTimeout(timer: unknown): void };
  };
  if (target.resizeTimeoutId == null) return;
  if (target.clock && typeof target.clock.clearTimeout === "function") {
    target.clock.clearTimeout(target.resizeTimeoutId);
  } else {
    clearTimeout(target.resizeTimeoutId as ReturnType<typeof setTimeout>);
  }
  target.resizeTimeoutId = null;
}

export function installShrinkResizeGuard(
  options: ShrinkResizeGuardOptions,
): () => void {
  const terminal = options.terminal ?? process.stdout;
  const signals = options.signals ?? process;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  let active = true;
  let previous = readSize(terminal);
  let settling: ReturnType<typeof setTimeout> | undefined;
  let suppressed = false;
  let originalRequestRender: (() => void) | undefined;

  const restore = (): void => {
    if (!suppressed) return;
    suppressed = false;
    if (originalRequestRender !== undefined) {
      options.renderer.requestRender = originalRequestRender;
      originalRequestRender = undefined;
    }
  };

  const heal = (): void => {
    if (options.renderer.isDestroyed) return;
    cancelPendingRendererResize(options.renderer);
    clearScreen(options.renderer, terminal);
    const bgColor = (
      options.renderer as unknown as { backgroundColor?: unknown }
    ).backgroundColor;
    options.renderer.currentRenderBuffer?.clear?.(bgColor);
    options.renderer.nextRenderBuffer?.clear?.(bgColor);
    if (!forceFullRepaint(options.renderer)) options.renderer.requestRender();
  };

  const onSettled = (): void => {
    settling = undefined;
    restore();
    if (!active) return;
    heal();
  };

  const onResizeSignal = (): void => {
    if (!active || options.renderer.isDestroyed) return;
    const next = readSize(terminal);
    const shrunk = isShrink(previous, next);
    previous = next;
    if (!shrunk) {
      if (!suppressed) return;
      if (settling !== undefined) clearTimeout(settling);
      onSettled();
      return;
    }
    if (!suppressed) {
      suppressed = true;
      originalRequestRender = options.renderer.requestRender.bind(options.renderer);
      options.renderer.requestRender = () => undefined;
    }
    cancelPendingRendererResize(options.renderer);
    options.renderer.resize(next.columns, next.rows);
    if (settling !== undefined) clearTimeout(settling);
    settling = setTimeout(onSettled, settleMs);
  };

  signals.on("SIGWINCH", onResizeSignal);
  return () => {
    if (!active) return;
    active = false;
    if (settling !== undefined) {
      clearTimeout(settling);
      settling = undefined;
    }
    restore();
    signals.off("SIGWINCH", onResizeSignal);
  };
}
