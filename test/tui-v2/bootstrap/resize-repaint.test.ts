import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  forceFullRepaint,
  repaintAttachedScreen,
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
const bun = spawnSync("bun", ["--version"], { encoding: "utf8" });
const bunMissing = bun.error && "code" in bun.error && bun.error.code === "ENOENT";

function fakeRenderer() {
  return {
    forceFullRepaintRequested: false,
    isDestroyed: false,
    requestRender: vi.fn(),
    currentRenderBuffer: { clear: vi.fn() },
    pause: vi.fn(),
    suspend: vi.fn(),
    resume: vi.fn(),
    idle: vi.fn(),
  };
}

describe("OpenTUI native repaint", () => {
  it("sets the native one-shot latch synchronously before scheduling the frame", () => {
    const renderer = fakeRenderer();
    renderer.requestRender.mockImplementation(() => {
      expect(renderer.forceFullRepaintRequested).toBe(true);
    });

    expect(forceFullRepaint(renderer)).toBe(true);

    expect(renderer.forceFullRepaintRequested).toBe(true);
    expect(renderer.requestRender).toHaveBeenCalledExactlyOnceWith();
    expect(renderer.currentRenderBuffer.clear).not.toHaveBeenCalled();
    expect(renderer.pause).not.toHaveBeenCalled();
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
    expect(renderer.idle).not.toHaveBeenCalled();
  });

  it("keeps repeated attach requests inside the renderer's existing scheduler", async () => {
    const renderer = fakeRenderer();
    expect(repaintAttachedScreen({ renderer })).toBe(true);
    expect(repaintAttachedScreen({ renderer })).toBe(true);
    expect(renderer.forceFullRepaintRequested).toBe(true);
    expect(renderer.requestRender).toHaveBeenCalledTimes(2);

    renderer.forceFullRepaintRequested = false;
    await Promise.resolve();

    expect(renderer.forceFullRepaintRequested).toBe(false);
    expect(renderer.requestRender).toHaveBeenCalledTimes(2);
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
    expect(renderer.idle).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false },
    { isSuspended: () => true },
  ])("declines attach repaint without terminal ownership: %o", (options) => {
    const renderer = fakeRenderer();
    expect(repaintAttachedScreen({ renderer, ...options })).toBe(false);
    expect(renderer.forceFullRepaintRequested).toBe(false);
    expect(renderer.requestRender).not.toHaveBeenCalled();
  });

  it("declines destroyed renderers without queuing work after the exit summary", () => {
    const renderer = fakeRenderer();
    renderer.isDestroyed = true;

    expect(repaintAttachedScreen({ renderer })).toBe(false);
    expect(renderer.forceFullRepaintRequested).toBe(false);
    expect(renderer.requestRender).not.toHaveBeenCalled();
  });

  it("declines unsupported renderer implementations rather than clearing their buffers", () => {
    const renderer = {
      requestRender: vi.fn(),
      currentRenderBuffer: { clear: vi.fn() },
    };

    expect(forceFullRepaint(renderer)).toBe(false);
    expect(renderer.requestRender).not.toHaveBeenCalled();
    expect(renderer.currentRenderBuffer.clear).not.toHaveBeenCalled();
    expect(renderer).not.toHaveProperty("forceFullRepaintRequested");
  });

  it.each([
    { value: undefined, writable: true },
    { value: "false", writable: true },
    { value: false, writable: false },
    { get: () => false, set: () => { throw new Error("unexpected setter"); } },
  ])("guards incompatible private latch descriptors: %o", (descriptor) => {
    const renderer = { requestRender: vi.fn() };
    Object.defineProperty(renderer, "forceFullRepaintRequested", descriptor);

    expect(forceFullRepaint(renderer)).toBe(false);
    expect(renderer.requestRender).not.toHaveBeenCalled();
  });

  it("declines a failed scheduling request without suspending or resuming input", () => {
    const renderer = fakeRenderer();
    renderer.requestRender.mockImplementation(() => {
      throw new Error("renderer unavailable");
    });

    expect(repaintAttachedScreen({ renderer })).toBe(false);
    expect(renderer.currentRenderBuffer.clear).not.toHaveBeenCalled();
    expect(renderer.suspend).not.toHaveBeenCalled();
    expect(renderer.resume).not.toHaveBeenCalled();
  });

  it.skipIf(bunMissing)("repaints unchanged text and blank cells through the installed native renderer", () => {
    expect(bun.status, bun.stderr).toBe(0);
    const result = spawnSync(
      "bun",
      ["run", join(root, "test/tui-v2/bootstrap/resize-repaint.native.ts")],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Native repaint regressions passed");
  }, 25_000);

  it.skipIf(bunMissing || process.platform === "win32")("preserves actual PTY raw mode, screen contents, and mouse input across native repaints", () => {
    const result = spawnSync(
      "python3",
      [join(root, "test/tui-v2/bootstrap/resize-repaint.pty.py")],
      { cwd: root, encoding: "utf8", timeout: 25_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(
      /PTY repaint continuity passed|PTY native output unavailable/,
    );
  }, 30_000);

  it("leaves resize invalidation and startup output exclusively to OpenTUI", () => {
    const source = readFileSync(
      join(root, "src/tui-v2/bootstrap/start-tui-v2.ts"),
      "utf8",
    );
    expect(source).not.toContain("installResizeRepaint");
    expect(source).not.toContain("createCoordinatedFlush");
    expect(source).not.toContain("writeTerminalDirect");
    expect(source).not.toContain("currentRenderBuffer");
    expect(source).toContain("RendererControlState.EXPLICIT_SUSPENDED");
    expect(source).toContain("enabled: Boolean(process.stdout.isTTY)");
    expect(source.slice(source.indexOf("await lifecycle.start()")))
      .not.toContain("repaintAttachedScreen({");
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
      join(root, "src/tui-v2/bootstrap/start-tui-v2.ts"),
      "utf8",
    );
    expect(tui).toContain("`${EXIT_SUMMARY_RESET}${text}`");
    expect(tui).toContain("writeTerminalAndWait");
    expect(tui).not.toContain("geometry.resized");

    const classic = readFileSync(
      join(root, "src/classic/bootstrap/start-classic.tsx"),
      "utf8",
    );
    expect(classic).toContain("`${EXIT_SUMMARY_RESET}${text}`");
    expect(classic).toContain("writeTerminalAndWait");
  });
});
