import { describe, expect, it } from "vitest";
import { FocusController } from "../../../src/tui-v2/controllers/focus-controller.js";
import { OverlayController } from "../../../src/tui-v2/controllers/overlay-controller.js";

function pickerRequest() {
  return { title: "Models", options: [{ value: "a", label: "a" }] };
}

describe("OverlayController (V2-071..076)", () => {
  it("opens a picker and routes focus to the picker context", () => {
    const focus = new FocusController("composer");
    const overlay = new OverlayController(focus);
    const selected: string[] = [];

    expect(overlay.openPicker(pickerRequest(), (v) => selected.push(v))).toBe(true);
    expect(overlay.getState().kind).toBe("picker");
    expect(focus.activeContext()).toBe("picker");

    overlay.selectPicker("a");
    expect(selected).toEqual(["a"]);
  });

  it("opens prompt actions in the modal focus context", () => {
    const focus = new FocusController("transcript");
    const overlay = new OverlayController(focus);

    expect(overlay.openPromptActions({ prompt: "send this again", onResend: () => {} })).toBe(true);
    expect(overlay.getState().kind).toBe("prompt-actions");
    expect(focus.activeContext()).toBe("modal");

    overlay.close();
    expect(focus.activeContext()).toBe("transcript");
  });

  it("rejects a second overlay while one is open (nested-action prevention)", () => {
    const focus = new FocusController("composer");
    const overlay = new OverlayController(focus);

    overlay.openPicker(pickerRequest(), () => {});
    expect(overlay.openJobs()).toBe(false);
    expect(overlay.getState().kind).toBe("picker");
  });

  it("restores the prior focus region when the overlay closes", () => {
    const focus = new FocusController("transcript");
    const overlay = new OverlayController(focus);

    overlay.openJobs();
    expect(focus.activeContext()).toBe("jobs");
    overlay.close();
    expect(focus.activeContext()).toBe("transcript");
    expect(overlay.getState().kind).toBe("none");
  });

  it("resolves an explicit confirm answer and closes", async () => {
    const overlay = new OverlayController(new FocusController());
    const pending = overlay.openConfirm({ kind: "tool", prompt: "run it?" });
    expect(overlay.getState().kind).toBe("confirm");

    overlay.answerConfirm(true);
    expect(await pending).toBe(true);
    expect(overlay.getState().kind).toBe("none");
  });

  it("resolves a nested confirm request as denied instead of hanging", async () => {
    const overlay = new OverlayController(new FocusController());
    overlay.openJobs();
    const nested = overlay.openConfirm({ kind: "tool", prompt: "run it?" });
    expect(await nested).toBe(false);
    expect(overlay.getState().kind).toBe("jobs");
  });

  it("resolves an explicit secret answer and closes", async () => {
    const overlay = new OverlayController(new FocusController());
    const pending = overlay.openSecret({ title: "key", prompt: "enter it" });
    overlay.answerSecret("sk-test");
    expect(await pending).toBe("sk-test");
    expect(overlay.getState().kind).toBe("none");
  });

  it("resolves pending confirm/secret promises safely on dispose", async () => {
    const overlay = new OverlayController(new FocusController());
    const confirmPromise = overlay.openConfirm({ kind: "tool", prompt: "x" });
    overlay.dispose();
    expect(await confirmPromise).toBe(false);

    const overlay2 = new OverlayController(new FocusController());
    const secretPromise = overlay2.openSecret({ title: "t", prompt: "p" });
    overlay2.dispose();
    expect(await secretPromise).toBeUndefined();
  });

  it("notifies subscribers on open and close", () => {
    const overlay = new OverlayController(new FocusController());
    let notifications = 0;
    overlay.subscribe(() => (notifications += 1));

    overlay.openJobs();
    overlay.close();
    expect(notifications).toBe(2);
  });

  it("suspends a plan confirm under a pager and restores it on close (F-021)", async () => {
    const focus = new FocusController("composer");
    const overlay = new OverlayController(focus);
    const pending = overlay.openConfirm(
      { kind: "plan", prompt: "implement?" },
      () => {
        overlay.openPager("Plan", "full detail");
      },
    );

    expect(overlay.getState().kind).toBe("confirm");
    const state = overlay.getState();
    if (state.kind === "confirm") state.onViewPlan?.();
    expect(overlay.getState().kind).toBe("pager");
    expect(focus.activeContext()).toBe("pager");

    overlay.close();
    expect(overlay.getState().kind).toBe("confirm");
    expect(focus.activeContext()).toBe("modal");

    overlay.answerConfirm(true);
    expect(await pending).toBe(true);
    expect(overlay.getState().kind).toBe("none");
    expect(focus.activeContext()).toBe("composer");
  });

  it("rejects non-plan overlays while a confirm is open", () => {
    const overlay = new OverlayController(new FocusController());
    overlay.openConfirm({ kind: "tool", prompt: "run?" });
    expect(overlay.openJobs()).toBe(false);
    expect(overlay.openPager("x", "y")).toBe(false);
  });
});
