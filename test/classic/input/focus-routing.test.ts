import { describe, expect, it } from "vitest";
import type { ActionContext, ActionId } from "../../../src/ui-core/actions/action-id.js";
import { ActionRouter } from "../../../src/ui-core/actions/action-router.js";
import { FocusController } from "../../../src/ui-core/controllers/focus-controller.js";
import { OverlayController } from "../../../src/ui-core/controllers/overlay-controller.js";
import { CancelCoordinator } from "../../../src/app/controllers/cancel-coordinator.js";
import { CancelLadder } from "../../../src/classic/input/cancel-ladder.js";
import { InputRouter } from "../../../src/classic/input/input-router.js";
import { keyEvent, type MouseEvent } from "../../../src/classic/input/key-event.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";

function build(options: { acceptsText?: boolean; hasSelection?: boolean; running?: boolean; now?: () => number } = {}) {
  const calls: string[] = [];
  const focus = new FocusController();
  const overlay = new OverlayController(focus);
  const session = {
    sessionId: "s1",
    getState: () => ({ running: options.running === true, compacting: false, queued: [] as string[] }),
    abort: () => calls.push("session.abort"),
    cancelAll: async () => {
      calls.push("session.cancelAll");
      return { ok: true };
    },
  };
  const ladder = new CancelLadder({
    now: options.now,
    coordinator: new CancelCoordinator({
      session,
      sessionId: () => "s1",
      jobs: { running: () => [], pendingNotifications: () => [] },
      interruptible: { hasWork: () => false, cancelAll: () => 0 },
    }),
    overlay: {
      cancelBlockingPrompt: () => {
        calls.push("overlay.cancelBlockingPrompt");
        return false;
      },
    },
    notify: (notice) => calls.push(`notify:${notice.text}`),
    requestExit: () => calls.push("requestExit"),
  });
  const router = new InputRouter({
    focus,
    router: new ActionRouter(),
    ladder,
    onAction: (action: ActionId) => calls.push(`action:${action}`),
    onPanelKey: (_key, chord, context: ActionContext) =>
      calls.push(`panel:${context}:${chord}`),
    onText: (text) => calls.push(`text:${text}`),
    onPaste: (text) => calls.push(`paste:${text.length}`),
    onMouse: (event: MouseEvent) => calls.push(`mouse:${event.x},${event.y}`),
    onToast: (text) => calls.push(`toast:${text}`),
    closeOverlay: () => {
      calls.push("overlay.close");
      overlay.close();
    },
    dismissBlockingPrompt: () => {
      calls.push("overlay.dismissBlockingPrompt");
      return false;
    },
    acceptsPaste: () => options.acceptsText !== false,
    acceptsText: () => options.acceptsText !== false,
    hasSelection: () => options.hasSelection === true,
  });
  return { calls, focus, router, ladder, overlay };
}

function feed(router: InputRouter, bytes: string): void {
  const decoder = new RawDecoder({ mouse: true });
  router.handleAll([...decoder.push(bytes), ...decoder.flush()]);
}

describe("paste ownership", () => {
  it("routes a paste to the focused text surface", () => {
    const { calls, router } = build();
    feed(router, "\x1b[200~hello\x1b[201~");
    expect(calls).toEqual(["paste:5"]);
  });

  it("drops a paste with a toast when no text surface is focused", () => {
    const { calls, router } = build({ acceptsText: false });
    feed(router, "\x1b[200~hello\x1b[201~");
    expect(calls).toEqual(["toast:paste ignored · focus the input first"]);
  });

  it("never resolves a pasted control byte to an action", () => {
    const { calls, router } = build();
    feed(router, "\x1b[200~\x03\x1b\x1b[201~");
    expect(calls).toEqual(["paste:0"]);
  });
});

describe("mouse ownership", () => {
  it("hands a decoded report to the mouse sink", () => {
    const { calls, router } = build();
    feed(router, "\x1b[<64;3;7M");
    expect(calls).toEqual(["mouse:2,6"]);
  });
});

describe("blocking overlays", () => {
  it("gives every key except escape and ctrl+c to the panel", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("secret");
    feed(router, "y");
    expect(calls).toEqual(["panel:secret:y"]);
  });

  it("escalates ctrl+c to the interrupt ladder", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("secret");
    feed(router, "\x03");
    expect(calls).toEqual([
      "overlay.cancelBlockingPrompt",
      "notify:Ctrl+C again to exit",
    ]);
  });

  it("escalates escape to the cancel ladder after dismissing the prompt", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("modal");
    feed(router, "\x1b");
    expect(calls).toEqual(["overlay.dismissBlockingPrompt"]);
  });
});

describe("non-blocking overlays", () => {
  it("resolves keys inside the overlay context", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("pager");
    feed(router, "j");
    expect(calls).toEqual(["action:pager.line-down"]);
  });

  it("closes on escape without arming cancellation", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("picker");
    feed(router, "\x1b");
    expect(calls).toEqual(["overlay.close"]);
  });

  it.each([false, true])("returns through pager and picker on raw Escape without cancelling a running turn (previously armed=%s)", async (armed) => {
    let now = 1000;
    const { calls, focus, router, ladder, overlay } = build({ running: true, now: () => now });
    if (armed) ladder.escape(false);
    overlay.openPicker({ title: "Agents", options: [{ value: "child", label: "Child" }] }, () => undefined);
    overlay.openPager("Child output", "Live finding");
    expect(focus.activeContext()).toBe("pager");

    now += 500;
    feed(router, "\x1b");
    expect(overlay.getState().kind).toBe("picker");
    expect(focus.activeContext()).toBe("picker");
    expect(ladder.escapeArmed).toBe(false);
    now += 500;
    feed(router, "\x1b");
    await Promise.resolve();
    expect(overlay.getState().kind).toBe("none");
    expect(focus.activeContext()).toBe("composer");
    expect(ladder.escapeArmed).toBe(false);
    expect(calls).not.toContain("session.cancelAll");
    expect(calls).not.toContain("session.abort");
    expect(calls).not.toContain("requestExit");

    now += 500;
    feed(router, "\x1b");
    expect(ladder.escapeArmed).toBe(true);
    expect(calls).not.toContain("session.cancelAll");
    now += 500;
    feed(router, "\x1b");
    await Promise.resolve();
    expect(calls.filter((call) => call === "session.cancelAll")).toHaveLength(1);
    overlay.dispose();
  });

  it("never falls through to a global action from a trapping context", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("picker");
    feed(router, "\x07");
    expect(calls).toEqual(["panel:picker:ctrl+g"]);
  });

  it("sends unresolved printable keys to the panel, not the composer", () => {
    const { calls, focus, router } = build();
    focus.pushOverlay("picker");
    feed(router, "z");
    expect(calls).toEqual(["panel:picker:z"]);
  });
});

describe("base regions", () => {
  it("inserts unresolved text when the composer accepts it", () => {
    const { calls, router } = build();
    feed(router, "h");
    expect(calls).toEqual(["text:h"]);
  });

  it("routes printable text from transcript focus back to the composer", () => {
    const { calls, focus, router } = build();
    focus.focusRegion("transcript");
    feed(router, "remaining");
    expect(calls).toEqual("remaining".split("").map((char) => `text:${char}`));
    expect(focus.activeContext()).toBe("transcript");
  });

  it("gives tab to the completion menu instead of focus.next-region", () => {
    const { calls, router } = build();
    feed(router, "\t");
    expect(calls).toEqual(["panel:composer:tab"]);
  });

  it("resolves a global action from the composer", () => {
    const { calls, router } = build();
    feed(router, "\x07");
    expect(calls).toEqual(["action:app.help"]);
  });

  it("resolves ctrl+j to the jobs action rather than a newline", () => {
    const { calls, router } = build();
    feed(router, "\n");
    expect(calls).toEqual(["action:app.jobs"]);
  });

  it.each([
    ["macOS", "\x04"],
    ["Linux", "\x04"],
    ["Windows Terminal", "\x1b[100;5u"],
  ])("routes Ctrl+D from the composer to transcript bottom on %s", (_platform, bytes) => {
    const { calls, router } = build();
    feed(router, bytes);
    expect(calls).toEqual(["action:transcript.bottom"]);
  });

  it("escalates escape from the transcript when nothing is selected", () => {
    const { calls, focus, router } = build();
    focus.focusRegion("transcript");
    feed(router, "\x1b");
    expect(calls).toEqual([]);
  });

  it("clears the selection first when the transcript has one", () => {
    const { calls, focus, router } = build({ hasSelection: true });
    focus.focusRegion("transcript");
    feed(router, "\x1b");
    expect(calls).toEqual(["action:selection.clear"]);
  });

  it("resolves shift+enter to a newline and enter to submit in the composer", () => {
    const { calls, router } = build();
    feed(router, "\x1b[13;2u");
    feed(router, "\r");
    expect(calls).toEqual(["action:editor.newline", "action:editor.submit"]);
  });

  it("routes a decoded key object without going through bytes", () => {
    const { calls, router } = build();
    router.handle({ type: "key", key: keyEvent("f5") });
    expect(calls).toEqual(["panel:composer:f5"]);
  });
});
