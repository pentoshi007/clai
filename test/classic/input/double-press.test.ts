import { describe, expect, it } from "vitest";
import { CancelLadder } from "../../../src/classic/input/cancel-ladder.js";
import {
  CTRL_C_QUIT_WINDOW_MS,
  ESC_CANCEL_WINDOW_MS,
  ESC_SAME_PRESS_MS,
} from "../../../src/classic/input/terminal-sequences.js";

interface HarnessOptions {
  readonly running?: boolean;
  readonly compacting?: boolean;
  readonly queued?: readonly string[];
  readonly runningJobs?: number;
  readonly pendingNotifications?: number;
  readonly blockingPrompt?: boolean;
  readonly cancelAllOk?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let now = 10_000;
  const calls: string[] = [];
  let running = options.running === true;
  let blocking = options.blockingPrompt === true;

  const ladder = new CancelLadder({
    now: () => now,
    session: {
      sessionId: "s1",
      getState: () => ({
        running,
        compacting: options.compacting === true,
        queued: options.queued ?? [],
      }),
      abort: () => {
        calls.push("abort");
        running = false;
      },
      cancelAll: async () => {
        calls.push("cancelAll");
        running = false;
        return { ok: options.cancelAllOk !== false };
      },
    },
    overlay: {
      cancelBlockingPrompt: () => {
        if (!blocking) return false;
        blocking = false;
        calls.push("dismissPrompt");
        return true;
      },
    },
    jobs: {
      running: () => Array.from({ length: options.runningJobs ?? 0 }),
      pendingNotifications: () =>
        Array.from({ length: options.pendingNotifications ?? 0 }),
    },
    notify: (notice) => calls.push(`notify(${notice.level}):${notice.text}`),
    requestExit: () => calls.push("requestExit"),
  });

  return {
    ladder,
    calls,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("Ctrl+C ladder", () => {
  it("aborts a running turn and arms quit on the first press", () => {
    const h = harness({ running: true });
    h.ladder.interrupt();
    expect(h.calls).toEqual([
      "abort",
      "notify(warn):Turn aborted · Ctrl+C again to exit",
    ]);
    expect(h.ladder.quitArmed).toBe(true);
  });

  it("exits on a second press inside the window", () => {
    const h = harness({ running: true });
    h.ladder.interrupt();
    h.advance(CTRL_C_QUIT_WINDOW_MS - 1);
    h.ladder.interrupt();
    expect(h.calls.at(-1)).toBe("requestExit");
  });

  it("arms then exits when idle", () => {
    const h = harness();
    h.ladder.interrupt();
    expect(h.calls).toEqual(["notify(info):Ctrl+C again to exit"]);
    h.ladder.interrupt();
    expect(h.calls.at(-1)).toBe("requestExit");
  });

  it("re-arms instead of exiting after the window lapses", () => {
    const h = harness();
    h.ladder.interrupt();
    h.advance(CTRL_C_QUIT_WINDOW_MS + 1);
    expect(h.ladder.quitArmed).toBe(false);
    h.ladder.interrupt();
    expect(h.calls).toEqual([
      "notify(info):Ctrl+C again to exit",
      "notify(info):Ctrl+C again to exit",
    ]);
  });

  it("dismisses a blocking prompt before anything else", () => {
    const h = harness({ blockingPrompt: true });
    h.ladder.interrupt();
    expect(h.calls).toEqual([
      "dismissPrompt",
      "notify(warn):Prompt cancelled · Ctrl+C again to exit",
    ]);
  });

  it("still exits on the second press while a hung turn refuses to settle", () => {
    const h = harness({ running: true });
    h.ladder.interrupt();
    h.calls.length = 0;
    h.ladder.interrupt();
    expect(h.calls).toEqual(["requestExit"]);
  });
});

describe("Esc ladder", () => {
  it("arms on the first press when there is cancelable work", () => {
    const h = harness({ running: true });
    h.ladder.escape(false);
    expect(h.calls).toEqual(["notify(info):esc again to cancel"]);
    expect(h.ladder.escapeArmed).toBe(true);
  });

  it("cancels everything on the second press", async () => {
    const h = harness({ running: true });
    h.ladder.escape(false);
    h.advance(ESC_SAME_PRESS_MS + 1);
    h.ladder.escape(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls).toEqual([
      "notify(info):esc again to cancel",
      "cancelAll",
      "notify(info):Cancelled turn, queue, and Responder jobs",
    ]);
  });

  it("warns when cancellation reports job stop failures", async () => {
    const h = harness({ running: true, cancelAllOk: false });
    h.ladder.escape(false);
    h.advance(ESC_SAME_PRESS_MS + 1);
    h.ladder.escape(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.calls.at(-1)).toBe(
      "notify(warn):Cancellation completed with job stop failures — open Jobs for details",
    );
  });

  it("re-arms rather than cancelling after the window lapses", () => {
    const h = harness({ running: true });
    h.ladder.escape(false);
    h.advance(ESC_CANCEL_WINDOW_MS + 1);
    h.ladder.escape(false);
    expect(h.calls).toEqual([
      "notify(info):esc again to cancel",
      "notify(info):esc again to cancel",
    ]);
    expect(h.calls).not.toContain("cancelAll");
  });

  it("collapses one physical Esc reaching two handlers inside 80 ms", () => {
    const h = harness({ running: true });
    h.ladder.escape(false);
    h.advance(ESC_SAME_PRESS_MS - 1);
    h.ladder.escape(false);
    expect(h.calls).toEqual(["notify(info):esc again to cancel"]);
  });

  it("arms on a queued prompt with no running turn", () => {
    const h = harness({ queued: ["next"] });
    h.ladder.escape(false);
    expect(h.calls).toEqual(["notify(info):esc again to cancel"]);
  });

  it("arms on responder work alone", () => {
    const h = harness({ runningJobs: 1 });
    h.ladder.escape(false);
    expect(h.ladder.escapeArmed).toBe(true);
    const pending = harness({ pendingNotifications: 2 });
    pending.ladder.escape(false);
    expect(pending.ladder.escapeArmed).toBe(true);
  });

  it("reports a dismissal when there is nothing to cancel", () => {
    const h = harness();
    h.ladder.escape(true);
    expect(h.calls).toEqual(["notify(info):Closed · Esc"]);
    expect(h.ladder.escapeArmed).toBe(false);
  });

  it("stays silent when nothing was dismissed and nothing is running", () => {
    const h = harness();
    h.ladder.escape(false);
    expect(h.calls).toEqual([]);
  });

  it("clears both ladders on demand", () => {
    const h = harness({ running: true });
    h.ladder.escape(false);
    h.ladder.interrupt();
    h.ladder.clear();
    expect(h.ladder.escapeArmed).toBe(false);
    expect(h.ladder.quitArmed).toBe(false);
  });
});
