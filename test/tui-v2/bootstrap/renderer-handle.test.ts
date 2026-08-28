import { describe, expect, it } from "vitest";
import { RendererLifecycle } from "../../../src/ui-core/bootstrap/lifecycle.js";
import { createOpenTuiRendererHandle } from "../../../src/tui-v2/bootstrap/renderer-handle.js";
import { installResizeRepaint } from "../../../src/tui-v2/bootstrap/resize-repaint.js";

describe("OpenTUI renderer teardown", () => {
  it("restores the normal screen before the exit epilogue runs", async () => {
    const events: string[] = [];
    let releaseIdle!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const renderer = {
      pause() {
        events.push("pause");
      },
      idle() {
        events.push("idle");
        return idle;
      },
      destroy() {
        events.push("alternate-screen-off");
      },
    };
    const { handle, done } = createOpenTuiRendererHandle({
      mount: () => events.push("mount"),
      unmount: () => events.push("unmount"),
      renderer,
      disarmTerminalRescue: () => events.push("rescue-disarmed"),
      disposeServices: () => events.push("services-disposed"),
    });
    const lifecycle = new RendererLifecycle({
      handle,
      epilogue: () => events.push("summary"),
    });

    await lifecycle.start();
    const shutdown = lifecycle.shutdown();
    await Promise.resolve();

    expect(events).toEqual(["mount", "unmount", "pause", "idle"]);
    expect(events).not.toContain("summary");

    releaseIdle();
    await shutdown;
    await done;

    expect(events).toEqual([
      "mount",
      "unmount",
      "pause",
      "idle",
      "alternate-screen-off",
      "rescue-disarmed",
      "services-disposed",
      "summary",
    ]);
  });

  it("releases terminal ownership when unmount fails", async () => {
    const events: string[] = [];
    const { handle, done } = createOpenTuiRendererHandle({
      mount: () => undefined,
      unmount: () => {
        events.push("unmount");
        throw new Error("unmount failed");
      },
      renderer: {
        pause: () => events.push("pause"),
        idle: async () => void events.push("idle"),
        destroy: () => events.push("alternate-screen-off"),
      },
      disarmTerminalRescue: () => events.push("rescue-disarmed"),
      disposeServices: () => events.push("services-disposed"),
    });

    await expect(handle.destroy()).rejects.toThrow("unmount failed");
    await done;

    expect(events).toEqual([
      "unmount",
      "pause",
      "idle",
      "alternate-screen-off",
      "rescue-disarmed",
      "services-disposed",
    ]);
  });

  it("prevents resize output after normal-screen restoration and the sign-off card", async () => {
    const events: string[] = [];
    const resizeListeners = new Set<(width: number, height: number) => void>();
    const renderer = {
      on(_event: "resize", listener: (width: number, height: number) => void) {
        resizeListeners.add(listener);
      },
      off(_event: "resize", listener: (width: number, height: number) => void) {
        resizeListeners.delete(listener);
      },
      pause: () => events.push("pause"),
      idle: async () => void events.push("idle"),
      destroy: () => events.push("alternate-screen-off"),
    };
    const disposeResize = installResizeRepaint({
      renderer,
      write: () => events.push("resize-clear"),
    });
    const { handle } = createOpenTuiRendererHandle({
      mount: () => events.push("mount"),
      unmount: () => events.push("unmount"),
      renderer,
      disarmTerminalRescue: () => events.push("rescue-disarmed"),
      disposeServices: () => events.push("services-disposed"),
    });
    const lifecycle = new RendererLifecycle({
      handle,
      disposers: [disposeResize],
      epilogue: () => events.push("summary"),
    });

    await lifecycle.start();
    for (const listener of resizeListeners) listener(62, 18);
    await lifecycle.shutdown();
    for (const listener of resizeListeners) listener(80, 24);

    expect(events).toEqual([
      "mount",
      "resize-clear",
      "unmount",
      "pause",
      "idle",
      "alternate-screen-off",
      "rescue-disarmed",
      "services-disposed",
      "summary",
    ]);
    expect(resizeListeners.size).toBe(0);
  });
});
