import { describe, expect, it } from "vitest";
import { RendererLifecycle } from "../../../src/ui-core/bootstrap/lifecycle.js";
import { createOpenTuiRendererHandle } from "../../../src/tui-v2/bootstrap/renderer-handle.js";
import { repaintAttachedScreen } from "../../../src/tui-v2/bootstrap/resize-repaint.js";

describe("OpenTUI renderer teardown", () => {
  it("restores the normal screen before the exit epilogue runs", async () => {
    const events: string[] = [];
    let releaseIdle!: () => void;
    let releaseFinalized!: () => void;
    const idle = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    const finalized = new Promise<void>((resolve) => {
      releaseFinalized = () => {
        events.push("alternate-screen-off");
        resolve();
      };
    });
    const renderer = {
      suspend() {
        events.push("suspend");
      },
      idle() {
        events.push("idle");
        return idle;
      },
      destroy() {
        events.push("destroy-requested");
      },
    };
    const { handle, done } = createOpenTuiRendererHandle({
      mount: () => events.push("mount"),
      unmount: () => events.push("unmount"),
      renderer,
      finalized,
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

    expect(events).toEqual(["mount", "unmount", "suspend", "idle"]);
    expect(events).not.toContain("summary");

    releaseIdle();
    await Promise.resolve();

    expect(events).toEqual([
      "mount",
      "unmount",
      "suspend",
      "idle",
      "destroy-requested",
    ]);
    expect(events).not.toContain("summary");

    releaseFinalized();
    await shutdown;
    await done;

    expect(events).toEqual([
      "mount",
      "unmount",
      "suspend",
      "idle",
      "destroy-requested",
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
        suspend: () => events.push("suspend"),
        idle: async () => void events.push("idle"),
        destroy: () => events.push("alternate-screen-off"),
      },
      finalized: Promise.resolve(),
      disarmTerminalRescue: () => events.push("rescue-disarmed"),
      disposeServices: () => events.push("services-disposed"),
    });

    await expect(handle.destroy()).rejects.toThrow("unmount failed");
    await done;

    expect(events).toEqual([
      "unmount",
      "suspend",
      "idle",
      "alternate-screen-off",
      "rescue-disarmed",
      "services-disposed",
    ]);
  });

  it("prevents attach repaint after normal-screen restoration and the sign-off card", async () => {
    const events: string[] = [];
    const renderer = {
      isDestroyed: false,
      forceFullRepaintRequested: false,
      requestRender: () => events.push("repaint-requested"),
      suspend: () => events.push("suspend"),
      idle: async () => void events.push("idle"),
      destroy() {
        this.isDestroyed = true;
        events.push("alternate-screen-off");
      },
    };
    const { handle } = createOpenTuiRendererHandle({
      mount: () => events.push("mount"),
      unmount: () => events.push("unmount"),
      renderer,
      finalized: Promise.resolve(),
      disarmTerminalRescue: () => events.push("rescue-disarmed"),
      disposeServices: () => events.push("services-disposed"),
    });
    const lifecycle = new RendererLifecycle({
      handle,
      epilogue: () => events.push("summary"),
    });

    await lifecycle.start();
    expect(repaintAttachedScreen({ renderer })).toBe(true);
    await lifecycle.shutdown();
    expect(repaintAttachedScreen({ renderer })).toBe(false);

    expect(events).toEqual([
      "mount",
      "repaint-requested",
      "unmount",
      "suspend",
      "idle",
      "alternate-screen-off",
      "rescue-disarmed",
      "services-disposed",
      "summary",
    ]);
  });
});
