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
  ERASE_TO_END,
  RESET_VISIBLE_SCREEN,
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

  it("reports applied resizes so the epilogue can reset a polluted screen", () => {
    const renderer = fakeRenderer();
    const geometry = { resized: false };
    let suspended = true;
    installResizeRepaint({
      renderer,
      write: () => {},
      isSuspended: () => suspended,
      onApplied: () => {
        geometry.resized = true;
      },
    });

    renderer.emitResize(80, 24);
    expect(geometry.resized).toBe(false);

    suspended = false;
    renderer.emitResize(80, 25);
    expect(geometry.resized).toBe(true);
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

  it("prints the sign-off card onto cleared space, resetting the screen only after a resize", () => {
    expect(ERASE_TO_END).toBe("\u001b[J");
    expect(RESET_VISIBLE_SCREEN).toBe("\u001b[H\u001b[J");
    expect(RESET_VISIBLE_SCREEN).not.toContain("2J");

    const tui = readFileSync(
      join(root, "src", "tui-v2", "bootstrap", "start-tui-v2.ts"),
      "utf8",
    );
    expect(tui).toContain("geometry.resized ? RESET_VISIBLE_SCREEN : ERASE_TO_END");
    expect(tui).toContain("`${reset}${text}`");

    const classic = readFileSync(
      join(root, "src", "classic", "bootstrap", "start-classic.tsx"),
      "utf8",
    );
    expect(classic).toMatch(/\$\{ERASE_TO_END\}\$\{text\}/);
  });
});
