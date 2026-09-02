import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESIZE_REPAINT_SEQUENCE,
  createCoordinatedFlush,
  forceFullRepaint,
  installResizeRepaint,
  repaintAttachedScreen,
  type CoordinatedFlushRenderer,
  type RepaintScheduler,
  type ResizeListener,
} from "../../../src/tui-v2/bootstrap/resize-repaint.js";
import {
  ABANDONED_TERMINAL_RESET,
  ERASE_TO_END,
  EXIT_SUMMARY_RESET,
  LEAVE_ALT_SCREEN,
  RESET_VISIBLE_SCREEN,
  TERMINAL_MODE_RESET,
} from "../../../src/os/screen-sequences.js";

const root = join(fileURLToPath(new URL("../../..", import.meta.url)));

function fakeRenderer() {
  const listeners = new Set<ResizeListener>();
  return {
    listenerCount: () => listeners.size,
    emitResize(width: number, height: number) {
      for (const listener of [...listeners]) listener(width, height);
    },
    on(_event: "resize", listener: ResizeListener) {
      listeners.add(listener);
      return this;
    },
    off(_event: "resize", listener: ResizeListener) {
      listeners.delete(listener);
      return this;
    },
  };
}

function manualScheduler(): {
  schedule: RepaintScheduler;
  flush: () => void;
  pending: () => number;
} {
  let queued: (() => void) | undefined;
  return {
    schedule: (run) => {
      queued = run;
      return () => {
        queued = undefined;
      };
    },
    flush: () => {
      const run = queued;
      queued = undefined;
      run?.();
    },
    pending: () => (queued ? 1 : 0),
  };
}

const immediate: RepaintScheduler = (run) => {
  run();
  return () => {};
};

describe("OpenTUI resize repaint", () => {
  it("repaints with erase-to-end rather than erase-display, which terminals may push to scrollback", () => {
    expect(RESIZE_REPAINT_SEQUENCE).toBe("\u001b[H\u001b[J");
    expect(RESIZE_REPAINT_SEQUENCE).not.toContain("2J");
    expect(RESIZE_REPAINT_SEQUENCE).not.toContain("3J");
  });

  it("coalesces a resize burst into a single clear instead of one torn frame per event", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const scheduler = manualScheduler();
    installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      schedule: scheduler.schedule,
    });

    renderer.emitResize(62, 18);
    renderer.emitResize(120, 40);
    renderer.emitResize(90, 30);
    expect(writes).toEqual([]);
    expect(scheduler.pending()).toBe(1);

    scheduler.flush();
    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE]);

    renderer.emitResize(100, 32);
    scheduler.flush();
    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE, RESIZE_REPAINT_SEQUENCE]);
  });

  it("forces a repaint after the clear, so growing the window cannot leave a blank frame", () => {
    // OpenTUI paints the new geometry before the coalesced clear lands. Without a
    // forced repaint the clear wipes that frame for good and only self-repainting
    // components (the composer) stay visible.
    const renderer = fakeRenderer();
    const order: string[] = [];
    const scheduler = manualScheduler();
    installResizeRepaint({
      renderer,
      write: () => order.push("clear"),
      requestRepaint: () => order.push("repaint"),
      schedule: scheduler.schedule,
    });

    renderer.emitResize(120, 40);
    expect(order).toEqual([]);
    scheduler.flush();

    expect(order).toEqual(["clear", "repaint"]);
  });

  it("does not repaint when the clear is skipped for a suspended renderer", () => {
    const renderer = fakeRenderer();
    const order: string[] = [];
    installResizeRepaint({
      renderer,
      write: () => order.push("clear"),
      requestRepaint: () => order.push("repaint"),
      isSuspended: () => true,
      schedule: immediate,
    });

    renderer.emitResize(120, 40);

    expect(order).toEqual([]);
  });

  it("invalidates the renderer's screen buffer before requesting the frame", () => {
    const calls: string[] = [];
    forceFullRepaint({
      currentRenderBuffer: { clear: () => calls.push("buffer-clear") },
      requestRender: () => calls.push("request-render"),
    });

    expect(calls).toEqual(["buffer-clear", "request-render"]);
  });

  it("clears and invalidates the renderer for an attached terminal", () => {
    const calls: string[] = [];
    const repainted = repaintAttachedScreen({
      renderer: {
        currentRenderBuffer: { clear: () => calls.push("buffer-clear") },
        requestRender: () => calls.push("request-render"),
      },
      write: (text) => calls.push(text),
    });

    expect(repainted).toBe(true);
    expect(calls).toEqual([
      "buffer-clear",
      "request-render",
      RESIZE_REPAINT_SEQUENCE,
    ]);
  });

  it("does not clear an attached terminal while rendering is suspended", () => {
    const calls: string[] = [];
    const repainted = repaintAttachedScreen({
      renderer: { requestRender: () => calls.push("request-render") },
      write: (text) => calls.push(text),
      isSuspended: () => true,
    });

    expect(repainted).toBe(false);
    expect(calls).toEqual([]);
  });

  it("still requests a frame when the screen buffer is gone or throws", () => {
    const calls: string[] = [];
    const clearThrew = forceFullRepaint({
      currentRenderBuffer: {
        clear: () => {
          throw new Error("buffer destroyed");
        },
      },
      requestRender: () => calls.push("request-render"),
    });
    const noBuffer = forceFullRepaint({
      requestRender: () => calls.push("request-render"),
    });

    expect(calls).toEqual(["request-render", "request-render"]);
    expect(clearThrew).toBe(true);
    expect(noBuffer).toBe(true);
  });

  it("declines an attached repaint when the frame cannot be scheduled", () => {
    const calls: string[] = [];
    const repainted = repaintAttachedScreen({
      renderer: {
        currentRenderBuffer: { clear: () => calls.push("buffer-clear") },
        requestRender: () => {
          calls.push("request-render");
          throw new Error("renderer destroyed");
        },
      },
      write: (text) => calls.push(text),
    });

    expect(calls).toEqual(["buffer-clear", "request-render"]);
    expect(calls).not.toContain(RESIZE_REPAINT_SEQUENCE);
    expect(repainted).toBe(false);
  });

  it("is wired to the live renderer from the OpenTUI bootstrap", () => {
    const source = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(source).toContain("requestRepaint: () => undefined");
  });

  it("clears on every settled resize so shrink cannot leave stale wide rows", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      schedule: immediate,
    });

    renderer.emitResize(62, 18);
    renderer.emitResize(100, 32);

    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE, RESIZE_REPAINT_SEQUENCE]);
  });

  it("clears regardless of suspension history once the renderer is active", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    let suspended = true;
    installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      isSuspended: () => suspended,
      schedule: immediate,
    });

    renderer.emitResize(80, 24);
    expect(writes).toEqual([]);

    suspended = false;
    renderer.emitResize(80, 25);
    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE]);
  });

  it("never clears while the renderer is suspended, so a pager on the normal screen is safe", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      isSuspended: () => true,
      schedule: immediate,
    });

    renderer.emitResize(80, 24);
    expect(writes).toEqual([]);
  });

  it("drops a scheduled clear when the renderer suspends before it flushes", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const scheduler = manualScheduler();
    let suspended = false;
    installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      isSuspended: () => suspended,
      schedule: scheduler.schedule,
    });

    renderer.emitResize(80, 24);
    suspended = true;
    scheduler.flush();

    expect(writes).toEqual([]);
  });

  it("stops clearing once disposed so teardown cannot wipe the exit summary", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const dispose = installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      schedule: immediate,
    });

    renderer.emitResize(70, 20);
    dispose();
    dispose();
    renderer.emitResize(60, 18);

    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE]);
    expect(renderer.listenerCount()).toBe(0);
  });

  it("cancels a pending clear on dispose so it cannot land after the sign-off card", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const scheduler = manualScheduler();
    const dispose = installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      schedule: scheduler.schedule,
    });

    renderer.emitResize(70, 20);
    dispose();
    scheduler.flush();

    expect(writes).toEqual([]);
    expect(renderer.listenerCount()).toBe(0);
  });

  it("stays inert when the renderer does not own a TTY", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const dispose = installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
      enabled: false,
    });

    renderer.emitResize(80, 24);
    dispose();

    expect(writes).toEqual([]);
    expect(renderer.listenerCount()).toBe(0);
  });

  it("is wired into the OpenTUI bootstrap with a suspend guard and torn down as a disposer", () => {
    const source = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(source).toContain("installResizeRepaint({");
    expect(source).toContain("RendererControlState.EXPLICIT_SUSPENDED");
    expect(source).toContain("enabled: Boolean(process.stdout.isTTY)");
    expect(source).toContain("disposeResizeRepaint,");
  });

  it("routes repaint bytes through a coordinated flush so they cannot interleave with a native frame", () => {
    const source = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(source).toContain("createCoordinatedFlush(renderer");
    expect(source).toContain("write: (text) => void flush(text)");
    expect(source).not.toContain("write: (text) => writeTerminalDirect(text)");
    expect(source).not.toContain("write: (text) => void process.stdout.write(text)");
  });

  describe("createCoordinatedFlush", () => {
    function flushRenderer(): CoordinatedFlushRenderer & {
      calls: string[];
      idleCalls: () => number;
    } {
      const calls: string[] = [];
      let idleCount = 0;
      return {
        calls,
        pause: () => void calls.push("pause"),
        suspend: () => void calls.push("suspend"),
        resume: () => void calls.push("resume"),
        requestRender: () => void calls.push("request-render"),
        currentRenderBuffer: { clear: () => void calls.push("buffer-clear") },
        idle: () => {
          idleCount += 1;
          return Promise.resolve();
        },
        idleCalls: () => idleCount,
      };
    }

    it("suspends, waits idle, writes, repaints, then resumes so the write never interleaves a frame or re-reads stdin", async () => {
      const renderer = flushRenderer();
      const flush = createCoordinatedFlush(renderer, (t) =>
        renderer.calls.push(`write:${t}`),
      );
      await flush("CLEAR");
      expect(renderer.calls).toEqual([
        "suspend",
        "write:CLEAR",
        "buffer-clear",
        "request-render",
        "resume",
      ]);
      expect(renderer.idleCalls()).toBe(1);
    });

    it("serializes concurrent flushes so two writes cannot interleave with each other", async () => {
      const renderer = flushRenderer();
      const flush = createCoordinatedFlush(renderer, (t) =>
        renderer.calls.push(`write:${t}`),
      );
      const p1 = flush("A");
      const p2 = flush("B");
      await Promise.all([p1, p2]);
      expect(renderer.calls).toEqual([
        "suspend",
        "write:A",
        "buffer-clear",
        "request-render",
        "resume",
        "suspend",
        "write:B",
        "buffer-clear",
        "request-render",
        "resume",
      ]);
      expect(renderer.idleCalls()).toBe(2);
    });

    it("still resumes if the write throws, so the render loop is never left paused", async () => {
      const renderer = flushRenderer();
      const flush = createCoordinatedFlush(renderer, () => {
        throw new Error("fd write failed");
      });
      await flush("X");
      expect(renderer.calls[renderer.calls.length - 1]).toBe("resume");
    });
  });

  it("keeps every exit sequence free of cursor movement so the card and the screen survive", () => {
    const cursorMoving = [
      "\u001b[r",
      "\u001b[H",
      "\u001b[f",
      "\u001b[1;1H",
      "\u001bc",
      "\u001b[u",
      "\u001b8",
    ];
    for (const sequence of [
      TERMINAL_MODE_RESET,
      EXIT_SUMMARY_RESET,
      ABANDONED_TERMINAL_RESET,
    ]) {
      for (const move of cursorMoving) {
        expect(sequence).not.toContain(move);
      }
    }
    expect(EXIT_SUMMARY_RESET.endsWith(ERASE_TO_END)).toBe(true);
    expect(ABANDONED_TERMINAL_RESET).not.toContain(ERASE_TO_END);
  });

  it("prints the sign-off card without erasing the screen the user had before clai", () => {
    expect(TERMINAL_MODE_RESET).not.toContain("1049");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?2026l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?1003l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?1006l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?2004l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?25h");
    expect(TERMINAL_MODE_RESET).not.toContain("\u001b[r");
    expect(ABANDONED_TERMINAL_RESET).toBe(`${TERMINAL_MODE_RESET}${LEAVE_ALT_SCREEN}`);
    expect(EXIT_SUMMARY_RESET).toBe(`${TERMINAL_MODE_RESET}${ERASE_TO_END}`);
    expect(EXIT_SUMMARY_RESET).not.toContain(LEAVE_ALT_SCREEN);
    expect(EXIT_SUMMARY_RESET).not.toContain(RESET_VISIBLE_SCREEN);
    expect(EXIT_SUMMARY_RESET).not.toContain("\u001b[H");
    expect(EXIT_SUMMARY_RESET).not.toContain("2J");
    expect(EXIT_SUMMARY_RESET).not.toContain("3J");

    const tui = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(tui).toContain("`${EXIT_SUMMARY_RESET}${text}`");
    expect(tui).toContain("writeTerminalAndWait");
    expect(tui).not.toContain("geometry.resized");

    const classic = readFileSync(
      join(root, "src", "classic", "bootstrap", "start-classic.tsx"),
      "utf8",
    );
    expect(classic).toContain("`${EXIT_SUMMARY_RESET}${text}`");
    expect(classic).toContain("writeTerminalAndWait");
  });
});
