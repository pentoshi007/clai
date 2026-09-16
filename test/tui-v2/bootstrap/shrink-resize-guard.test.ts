import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installShrinkResizeGuard } from "../../../src/tui-v2/bootstrap/shrink-resize-guard.js";

const CLEAR_SCREEN = "\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H";

function harness(columns = 100, rows = 24) {
  const signalListeners = new Set<() => void>();
  const written: string[] = [];
  const terminal: {
    columns: number;
    rows: number;
    getWindowSize?: () => [number, number];
    write?: (text: string) => void;
  } = {
    columns,
    rows,
    write: (text: string) => {
      written.push(text);
    },
  };
  const signals = {
    on: vi.fn((_event: "SIGWINCH", listener: () => void) => signalListeners.add(listener)),
    off: vi.fn((_event: "SIGWINCH", listener: () => void) => signalListeners.delete(listener)),
    emitResize: () => [...signalListeners].forEach((listener) => listener()),
  };
  let frames = 0;
  const renderer = {
    width: columns,
    height: rows,
    isDestroyed: false,
    forceFullRepaintRequested: false,
    backgroundColor: undefined,
    currentRenderBuffer: {
      clear: vi.fn(),
    },
    nextRenderBuffer: {
      clear: vi.fn(),
    },
    writeOut: vi.fn((text: string) => {
      written.push(text);
    }),
    resize: vi.fn((nextColumns: number, nextRows: number) => {
      renderer.width = nextColumns;
      renderer.height = nextRows;
      renderer.requestRender();
    }),
    requestRender: vi.fn(() => {
      frames += 1;
    }),
  };
  return { terminal, signals, renderer, rendered: () => frames, written };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("shrink resize guard", () => {
  it("resizes synchronously on shrink, suppresses burst frames, then heals", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 60;
    test.signals.emitResize();
    expect(test.renderer.resize).toHaveBeenCalledOnce();
    expect(test.renderer.resize).toHaveBeenCalledWith(60, 24);
    expect(test.rendered()).toBe(0);

    test.renderer.requestRender();
    expect(test.rendered()).toBe(0);

    vi.advanceTimersByTime(200);
    expect(test.renderer.forceFullRepaintRequested).toBe(true);
    expect(test.rendered()).toBe(1);
    expect(test.renderer.currentRenderBuffer.clear).toHaveBeenCalledOnce();
    expect(test.written).toContain(CLEAR_SCREEN);

    dispose();
    expect(test.signals.off).toHaveBeenCalledOnce();
  });

  it("ignores expansion and keeps rendering untouched", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 140;
    test.signals.emitResize();
    expect(test.renderer.resize).not.toHaveBeenCalled();

    test.renderer.requestRender();
    expect(test.rendered()).toBe(1);

    vi.advanceTimersByTime(500);
    expect(test.rendered()).toBe(1);

    dispose();
  });

  it("tracks every drag step but heals once after the burst settles", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 80;
    test.signals.emitResize();
    vi.advanceTimersByTime(50);
    test.terminal.columns = 60;
    test.signals.emitResize();

    expect(test.renderer.resize).toHaveBeenCalledTimes(2);
    expect(test.renderer.resize).toHaveBeenLastCalledWith(60, 24);
    expect(test.rendered()).toBe(0);
    expect(test.renderer.forceFullRepaintRequested).toBe(false);

    vi.advanceTimersByTime(100);
    expect(test.renderer.forceFullRepaintRequested).toBe(false);
    vi.advanceTimersByTime(100);
    expect(test.renderer.forceFullRepaintRequested).toBe(true);
    expect(test.rendered()).toBe(1);

    dispose();
  });

  it("prefers a fresh window size when cached columns are stale", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.getWindowSize = () => [60, 24];
    test.signals.emitResize();
    expect(test.renderer.resize).toHaveBeenCalledOnce();
    expect(test.renderer.resize).toHaveBeenCalledWith(60, 24);
    expect(test.rendered()).toBe(0);

    vi.advanceTimersByTime(200);
    expect(test.rendered()).toBe(1);

    dispose();
  });

  it("restores rendering on dispose without healing", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 60;
    test.signals.emitResize();
    expect(test.rendered()).toBe(0);
    dispose();

    test.renderer.requestRender();
    expect(test.rendered()).toBe(1);

    vi.advanceTimersByTime(500);
    expect(test.renderer.forceFullRepaintRequested).toBe(false);
    expect(test.rendered()).toBe(1);
  });

  it("heals immediately if expansion occurs while shrink is pending", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 80;
    test.signals.emitResize();
    expect(test.rendered()).toBe(0);

    test.terminal.columns = 100;
    test.signals.emitResize();
    expect(test.rendered()).toBe(1);
    expect(test.renderer.forceFullRepaintRequested).toBe(true);
    expect(test.written).toContain(CLEAR_SCREEN);

    dispose();
  });

  it("falls back to terminal.write when writeOut is not available", () => {
    const test = harness();
    const rendererWithoutWriteOut = {
      ...test.renderer,
      writeOut: undefined,
    };
    const dispose = installShrinkResizeGuard({
      renderer: rendererWithoutWriteOut,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.terminal.columns = 60;
    test.signals.emitResize();
    vi.advanceTimersByTime(200);
    expect(test.written).toContain(CLEAR_SCREEN);

    dispose();
  });

  it("ignores signals when destroyed and for empty sizes", () => {
    const test = harness();
    const dispose = installShrinkResizeGuard({
      renderer: test.renderer,
      terminal: test.terminal,
      signals: test.signals,
    });

    test.renderer.isDestroyed = true;
    test.terminal.columns = 60;
    test.signals.emitResize();
    expect(test.renderer.resize).not.toHaveBeenCalled();

    test.renderer.isDestroyed = false;
    test.terminal.columns = 0;
    test.terminal.rows = 0;
    test.signals.emitResize();
    expect(test.renderer.resize).not.toHaveBeenCalled();

    dispose();
    test.terminal.columns = 40;
    test.terminal.rows = 10;
    test.signals.emitResize();
    expect(test.renderer.resize).not.toHaveBeenCalled();
  });
});
