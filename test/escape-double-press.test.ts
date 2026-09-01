import { describe, expect, it } from "vitest";
import { escapeCancellationAction } from "../src/tui-v2/input/escape-cancellation.js";
import { CancelLadder } from "../src/classic/input/cancel-ladder.js";
import {
  ESC_CANCEL_WINDOW_MS,
  ESC_SAME_PRESS_MS,
} from "../src/ui-core/actions/cancel-timing.js";

function openTuiLadder(now: () => number) {
  let lastEscape = 0;
  let lastHandled = 0;
  const events: string[] = [];
  return {
    events,
    escape(hasCancelableWork: boolean, dismissed = false): void {
      const at = now();
      if (lastHandled > 0 && at - lastHandled < ESC_SAME_PRESS_MS) return;
      lastHandled = at;
      const doublePress =
        lastEscape > 0 && at - lastEscape < ESC_CANCEL_WINDOW_MS;
      const action = escapeCancellationAction({
        dismissed,
        doublePress,
        hasCancelableWork,
      });
      if (action === "cancel-all") {
        lastEscape = 0;
        events.push("cancelAll");
        return;
      }
      if (action === "arm") {
        lastEscape = at;
        events.push("arm");
        return;
      }
      lastEscape = 0;
      events.push(action);
    },
  };
}

function classicLadder(now: () => number) {
  const calls: string[] = [];
  const ladder = new CancelLadder({
    coordinator: {
      abortForeground: () => ({ turnAborted: true, interruptibleCancelled: 0 }),
      hasCancelableWork: () => true,
      cancelAll: async () => {
        calls.push("cancelAll");
        return { ok: true };
      },
    } as never,
    overlay: { cancelBlockingPrompt: () => false },
    notify: (notice) =>
      calls.push(notice.key === "escape-arm" ? "arm" : notice.key),
    requestExit: () => calls.push("exit"),
    now,
  });
  return { calls, ladder };
}

describe("Escape aborts only on a double press", () => {
  it("arms on the first press and cancels on the second", () => {
    let clock = 10_000;
    const ladder = openTuiLadder(() => clock);

    ladder.escape(true);
    expect(ladder.events).toEqual(["arm"]);

    clock += 400;
    ladder.escape(true);
    expect(ladder.events).toEqual(["arm", "cancelAll"]);
  });

  it("never cancels from single presses, however many times the window lapses", () => {
    let clock = 10_000;
    const ladder = openTuiLadder(() => clock);

    for (let press = 0; press < 3; press += 1) {
      ladder.escape(true);
      clock += ESC_CANCEL_WINDOW_MS + 1;
    }

    expect(ladder.events).toEqual(["arm", "arm", "arm"]);
  });

  it("treats one physical press delivered to several handlers as one press", () => {
    let clock = 10_000;
    const ladder = openTuiLadder(() => clock);

    ladder.escape(true);
    clock += ESC_SAME_PRESS_MS - 1;
    ladder.escape(true);

    expect(ladder.events).toEqual(["arm"]);
  });

  it("stays inert when there is nothing to cancel", () => {
    let clock = 10_000;
    const ladder = openTuiLadder(() => clock);

    ladder.escape(false);
    clock += 200;
    ladder.escape(false);

    expect(ladder.events).toEqual(["none", "none"]);
  });

  it("lets an overlay dismissal win without arming", () => {
    let clock = 10_000;
    const ladder = openTuiLadder(() => clock);

    ladder.escape(true, true);
    clock += 200;
    ladder.escape(true, true);

    expect(ladder.events).toEqual(["dismiss", "dismiss"]);
  });

  it("reaches the same outcomes in the classic ladder", async () => {
    let clock = 10_000;
    const classic = classicLadder(() => clock);

    classic.ladder.escape(false);
    expect(classic.calls).toEqual(["arm"]);

    clock += 400;
    classic.ladder.escape(false);
    await Promise.resolve();
    expect(classic.calls).toContain("cancelAll");
  });
});
