import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTION_IDS, type ActionId } from "../../../src/ui-core/actions/action-id.js";
import { defaultKeymap } from "../../../src/ui-core/actions/keymap.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function keyFor(text = ""): { readonly text: string } {
  return { text };
}

function chordFor(action: ActionId): string {
  return defaultKeymap.find((binding) => binding.action === action)?.chord ?? "";
}

const COMPOSER_ACTIONS: readonly ActionId[] = [
  "editor.submit",
  "editor.newline",
  "editor.history-prev",
  "editor.history-next",
  "editor.clear",
  "editor.cut-draft",
];

const PANEL_ACTIONS: readonly ActionId[] = [
  "picker.up",
  "picker.down",
  "picker.accept",
  "picker.dismiss",
  "picker.filter",
  "modal.confirm",
  "modal.deny",
  "modal.dismiss",
  "pager.line-up",
  "pager.line-down",
  "pager.page-up",
  "pager.page-down",
  "pager.half-page-up",
  "pager.half-page-down",
  "pager.top",
  "pager.bottom",
  "pager.search",
  "pager.next-match",
  "pager.prev-match",
  "pager.export-scrollback",
  "pager.export-editor",
  "pager.copy",
  "pager.toggle-follow",
  "pager.format",
  "pager.raw",
  "pager.close",
  "jobs.up",
  "jobs.down",
  "jobs.tail",
  "jobs.view-live",
  "jobs.stop",
  "jobs.close",
];

const PLAN_ACTIONS: readonly ActionId[] = [
  "plan.next-task",
  "plan.prev-task",
  "plan.toggle-detail",
];

const SELECTION_EXTEND_ACTIONS: readonly ActionId[] = [
  "selection.extend-left",
  "selection.extend-right",
  "selection.extend-up",
  "selection.extend-down",
  "selection.extend-word-left",
  "selection.extend-word-right",
  "selection.extend-line-start",
  "selection.extend-line-end",
];

describe("classic action reachability", () => {
  it("dispatches every ActionId without throwing", () => {
    harness = createHarness();
    const active = harness.wiring;
    for (const action of ACTION_IDS) {
      if (action === "app.quit") continue;
      expect(() =>
        active.actions.handle(action, chordFor(action), keyFor()),
      ).not.toThrow();
    }
  });

  it("routes every composer action to the composer controller", () => {
    harness = createHarness();
    const spy = vi.spyOn(harness.wiring.composer, "handleAction");
    for (const action of COMPOSER_ACTIONS) {
      harness.wiring.actions.handle(action, chordFor(action), keyFor());
    }
    expect(spy.mock.calls.map(([action]) => action)).toEqual([...COMPOSER_ACTIONS]);
  });

  it("routes every overlay action to the panel controller", () => {
    harness = createHarness();
    const spy = vi.spyOn(harness.wiring.panels, "handleKey");
    for (const action of PANEL_ACTIONS) {
      harness.wiring.actions.handle(action, chordFor(action), keyFor());
    }
    expect(spy).toHaveBeenCalledTimes(PANEL_ACTIONS.length);
  });

  it("routes plan actions to the panel plan reducer", () => {
    harness = createHarness();
    const spy = vi.spyOn(harness.wiring.panels, "handlePlanKey");
    for (const action of PLAN_ACTIONS) {
      harness.wiring.actions.handle(action, chordFor(action), keyFor());
    }
    expect(spy).toHaveBeenCalledTimes(PLAN_ACTIONS.length);
  });

  it("sends cancellation actions through the single cancel ladder", () => {
    harness = createHarness();
    const interrupt = vi.spyOn(harness.wiring.ladder, "interrupt");
    const escape = vi.spyOn(harness.wiring.ladder, "escape");
    harness.wiring.actions.handle("app.interrupt", "ctrl+c", keyFor());
    harness.wiring.actions.handle("app.cancel", "escape", keyFor());
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(escape).toHaveBeenCalledTimes(1);
  });

  it("cycles mode and reports it once", () => {
    harness = createHarness();
    harness.wiring.actions.handle("app.cycle-mode", "shift+tab", keyFor());
    expect(harness.services.session.getState().mode).not.toBe("agent");
    expect(harness.toastTexts().some((text) => text.startsWith("Mode ·"))).toBe(true);
  });

  it("opens the jobs panel and the help pager through the overlay controller", () => {
    harness = createHarness();
    harness.wiring.actions.handle("app.jobs", chordFor("app.jobs"), keyFor());
    expect(harness.services.overlay.getState().kind).toBe("jobs");
    harness.services.overlay.close();
    harness.wiring.actions.handle("app.help", chordFor("app.help"), keyFor());
    expect(harness.services.overlay.getState().kind).toBe("pager");
  });

  it("moves focus between regions", () => {
    harness = createHarness();
    harness.wiring.actions.handle("focus.transcript", "", keyFor());
    expect(harness.services.focus.region()).toBe("transcript");
    harness.wiring.actions.handle("focus.composer", "", keyFor());
    expect(harness.services.focus.region()).toBe("composer");
    harness.wiring.actions.handle("focus.next-region", "", keyFor());
    expect(harness.services.focus.region()).toBe("transcript");
  });

  it("clears the selection and then falls through to the cancel ladder", () => {
    harness = createHarness();
    const clear = vi.spyOn(harness.services.selection, "clear");
    const escape = vi.spyOn(harness.wiring.ladder, "escape");
    harness.wiring.actions.handle("selection.clear", "escape", keyFor());
    expect(clear).toHaveBeenCalledTimes(1);
    expect(escape).toHaveBeenCalledWith(false);
  });

  it("only extends a selection while the pager owns focus", () => {
    harness = createHarness();
    const spy = vi.spyOn(harness.wiring.panels, "handleKey");
    for (const action of SELECTION_EXTEND_ACTIONS) {
      harness.wiring.actions.handle(action, chordFor(action), keyFor());
    }
    expect(spy).not.toHaveBeenCalled();

    harness.services.overlay.openPager("Body", "one\ntwo\nthree");
    for (const action of SELECTION_EXTEND_ACTIONS) {
      harness.wiring.actions.handle(action, chordFor(action), keyFor());
    }
    expect(spy).toHaveBeenCalledTimes(SELECTION_EXTEND_ACTIONS.length);
  });
});
