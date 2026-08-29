import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RESIZE_REPAINT_SEQUENCE,
  installResizeRepaint,
  type ResizeListener,
} from "../../../src/tui-v2/bootstrap/resize-repaint.js";
import {
  ABANDONED_TERMINAL_RESET,
  LEAVE_ALT_SCREEN,
  NORMAL_SCREEN_RESET,
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

describe("OpenTUI resize repaint", () => {
  it("repaints with erase-to-end rather than erase-display, which terminals may push to scrollback", () => {
    expect(RESIZE_REPAINT_SEQUENCE).toBe("\u001b[H\u001b[J");
    expect(RESIZE_REPAINT_SEQUENCE).not.toContain("2J");
    expect(RESIZE_REPAINT_SEQUENCE).not.toContain("3J");
  });

  it("clears on every applied resize so shrink cannot leave stale wide rows", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    installResizeRepaint({ renderer, write: (text) => writes.push(text) });

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
    });

    renderer.emitResize(80, 24);
    expect(writes).toEqual([]);
  });

  it("stops clearing once disposed so teardown cannot wipe the exit summary", () => {
    const renderer = fakeRenderer();
    const writes: string[] = [];
    const dispose = installResizeRepaint({
      renderer,
      write: (text) => writes.push(text),
    });

    renderer.emitResize(70, 20);
    dispose();
    dispose();
    renderer.emitResize(60, 18);

    expect(writes).toEqual([RESIZE_REPAINT_SEQUENCE]);
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

  it("prints the sign-off card onto an unconditionally reset screen in both surfaces", () => {
    expect(TERMINAL_MODE_RESET).not.toContain("1049");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?2026l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?1003l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?1006l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?2004l");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[?25h");
    expect(TERMINAL_MODE_RESET).toContain("\u001b[r");
    expect(NORMAL_SCREEN_RESET).toBe(`${TERMINAL_MODE_RESET}${RESET_VISIBLE_SCREEN}`);
    expect(NORMAL_SCREEN_RESET).not.toContain("2J");
    expect(NORMAL_SCREEN_RESET).not.toContain("3J");
    expect(ABANDONED_TERMINAL_RESET).toBe(`${TERMINAL_MODE_RESET}${LEAVE_ALT_SCREEN}`);

    const tui = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(tui).toContain("`${NORMAL_SCREEN_RESET}${text}`");
    expect(tui).not.toContain("geometry.resized");

    const classic = readFileSync(
      join(root, "src", "classic", "bootstrap", "start-classic.tsx"),
      "utf8",
    );
    expect(classic).toContain("`${NORMAL_SCREEN_RESET}${text}`");
  });
});
