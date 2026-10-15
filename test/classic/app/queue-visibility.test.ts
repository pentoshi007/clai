import { createElement } from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { formatShortcutsReference } from "../../../src/ui-core/actions/format-shortcuts.js";
import type { OverlayContext } from "../../../src/ui-core/controllers/focus-controller.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { createPlan } from "../../../src/store/plan.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

function withQueue(prompts: readonly string[], columns = 120): Harness {
  harness = createHarness({ columns, rows: 40, agent: { runTurn: async () => "" } });
  for (const prompt of prompts) harness.services.session.enqueue(prompt);
  return harness;
}

function toggle(h: Harness): void {
  h.wiring.handleData("\x1a");
}

describe("classic queue visibility", () => {
  it.each(["composer", "transcript", "plan"] as const)("toggles from %s without losing drafts, selection or queue entries", async (region) => {
    const h = withQueue(["first\ncomplete message", "second 界🙂"]);
    h.wiring.composer.setText("draft to preserve");
    h.wiring.setQueueSelected(1);
    h.services.focus.focusRegion(region);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueSelected).toBe(1));
    const queued = h.services.session.getState().queued;
    expect(h.wiring.getSnapshot().queueVisible).toBe(true);
    toggle(h);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(false));
    expect(h.services.session.getState().queued).toEqual(queued);
    expect(h.wiring.getSnapshot().queueSelected).toBe(1);
    expect(h.wiring.composer.getSnapshot().state.text).toBe("draft to preserve");
    expect(h.services.focus.region()).toBe(region);
    toggle(h);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(true));
    expect(h.services.session.getState().queued).toEqual(queued);
  });

  const contexts: readonly OverlayContext[] = ["picker", "modal", "secret", "transcript-search", "pager", "jobs"];
  it.each(contexts)("does not toggle through a trapping %s overlay", async (context) => {
    const h = withQueue(["queued"]);
    const release = h.services.focus.pushOverlay(context);
    try {
      toggle(h);
      expect(h.wiring.queueVisibleValue).toBe(true);
      await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(true));
      expect(h.services.session.getState().queued).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("does not toggle while editing the context limit", () => {
    const h = withQueue(["queued"]);
    h.wiring.startContextLimitEditing();
    toggle(h);
    expect(h.wiring.queueVisibleValue).toBe(true);
    expect(h.wiring.contextLimitEditingValue).toBe(true);
  });

  it("preserves hidden state after emptying the queue and enqueuing again", async () => {
    const h = withQueue(["remove me"]);
    toggle(h);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(false));
    h.wiring.handleData("\x1f");
    await vi.waitFor(() => expect(h.wiring.getSnapshot().session.queued).toHaveLength(0));
    expect(h.wiring.getSnapshot().queueVisible).toBe(false);
    h.services.session.enqueue("new message stays hidden");
    await vi.waitFor(() => expect(h.wiring.getSnapshot().session.queued).toHaveLength(1));
    expect(h.wiring.getSnapshot().queueVisible).toBe(false);
    toggle(h);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(true));
  });

  it("retains selected queue editing and removal while hidden", async () => {
    const h = withQueue(["keep", "edit this\nfull message", "drop"]);
    toggle(h);
    h.wiring.handleData("\x16");
    h.wiring.handleData("\x1d");
    await vi.waitFor(() => expect(h.wiring.getSnapshot().composer.state.text).toBe("edit this\nfull message"));
    expect(h.services.session.getState().queued).toEqual(["keep", "drop"]);
    h.wiring.handleData("\x1f");
    expect(h.services.session.getState().queued).toEqual(["keep"]);
    expect(h.wiring.queueVisibleValue).toBe(false);
  });

  it("can send and drain queued prompts while their blocks are hidden", async () => {
    const h = withQueue(["first", "second"]);
    toggle(h);
    h.wiring.handleData("\x16");
    h.wiring.handleData("\x13");
    await vi.waitFor(() => {
      const state = h.services.session.getState();
      expect(state.queued).toHaveLength(0);
      expect(state.running).toBe(false);
    });
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueSelected).toBe(0));
    expect(h.wiring.getSnapshot().queueVisible).toBe(false);
  });

  it.each([40, 68, 120])("hides and restores actual queue frames at %i columns", async (columns) => {
    const h = withQueue(["QUEUED_ALPHA", "QUEUED_BETA"], columns);
    const plan = createPlan({ sessionId: h.services.session.sessionId, goal: "Plan", detail: "", taskTitles: ["Keep working"] });
    vi.spyOn(h.services.plan, "current").mockReturnValue(plan);
    h.wiring.schedulePaint();
    const ui = render(createElement(ServicesProvider, {
      services: h.services,
      children: createElement(ClassicApp, { wiring: h.wiring }),
    }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("QUEUED_BETA"));
      const visibleRows = h.wiring.feedViewportRows;
      const taskQueueRow = (): string => ui.lastFrame()!.split("\n").find((row) => row.includes("Ctrl+Z") && /cntrl\+H|\^H/.test(row))!;
      expect(taskQueueRow()).toMatch(/(?:cntrl\+H|\^H).*2(?: queued|q).*Ctrl\+Z/);
      toggle(h);
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("QUEUED_ALPHA"));
      expect(ui.lastFrame()).not.toContain("QUEUED_BETA");
      expect(taskQueueRow()).toMatch(/(?:cntrl\+H|\^H).*2(?: queued|q).*hidden.*Ctrl\+Z/);
      await vi.waitFor(() => expect(h.wiring.feedViewportRows).toBe(visibleRows + 3));
      expect(h.services.session.getState().queued).toEqual(["QUEUED_ALPHA", "QUEUED_BETA"]);
      toggle(h);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("QUEUED_BETA"));
      expect(taskQueueRow()).not.toContain("hidden");
      h.wiring.togglePlan();
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("Keep working"));
      expect(taskQueueRow()).toMatch(/(?:cntrl\+H|\^H).*2(?: queued|q).*Ctrl\+Z/);
    } finally {
      ui.unmount();
      ui.cleanup();
    }
  });

  it("hides the queue by default only when explicitly toggled, even while empty", async () => {
    const h = withQueue([]);
    toggle(h);
    await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(false));
    h.services.session.enqueue("queued afterwards");
    await vi.waitFor(() => expect(h.wiring.getSnapshot().session.queued).toHaveLength(1));
    expect(h.wiring.getSnapshot().queueVisible).toBe(false);
  });

  it("documents the classic-only shortcut without rebinding other renderers", () => {
    const h = withQueue([]);
    expect(h.services.router.resolve("alt+q", "composer")).toBeUndefined();
    expect(h.services.router.resolve("ctrl+z", "composer")).toBeUndefined();
    expect(formatShortcutsReference()).toMatch(/Classic[^\n]*Ctrl\+Z[^\n]*queued/i);
  });
});

it("keeps queued submission and automatic draining active while hidden during a turn", async () => {
  let finish: (() => void) | undefined;
  const blocked = new Promise<string>((resolve) => { finish = () => resolve(""); });
  harness = createHarness({ columns: 120, rows: 40, agent: { runTurn: async () => blocked } });
  const h = harness;
  const plan = createPlan({ sessionId: h.services.session.sessionId, goal: "Plan", detail: "", taskTitles: ["Keep working"] });
  vi.spyOn(h.services.plan, "current").mockReturnValue(plan);
  const submitted = h.services.session.submit("current turn");
  await vi.waitFor(() => expect(h.services.session.getState().running).toBe(true));
  h.wiring.composer.setText("QUEUED_DURING_RUNNING");
  h.wiring.handleData("\r");
  await vi.waitFor(() => expect(h.wiring.getSnapshot().session.queued).toEqual(["QUEUED_DURING_RUNNING"]));
  const ui = render(createElement(ServicesProvider, {
    services: h.services,
    children: createElement(ClassicApp, { wiring: h.wiring }),
  }));
  try {
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("QUEUED_DURING_RUNNING"));
    expect(ui.lastFrame()).toMatch(/cntrl\+H to expand · 1 queued . Ctrl\+Z to hide/);
    toggle(h);
    await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("QUEUED_DURING_RUNNING"));
    expect(ui.lastFrame()).toMatch(/cntrl\+H to expand · 1 queued \(hidden\) . Ctrl\+Z to show/);
    expect(h.services.session.getState().queued).toEqual(["QUEUED_DURING_RUNNING"]);
    expect(h.services.session.getState().running).toBe(true);
    finish?.();
    await submitted;
    await vi.waitFor(() => {
      expect(h.services.session.getState().running).toBe(false);
      expect(h.services.session.getState().queued).toHaveLength(0);
    });
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("Queue hidden . Ctrl+Z to show"));
    expect(h.wiring.getSnapshot().queueVisible).toBe(false);
  } finally {
    finish?.();
    await submitted.catch(() => undefined);
    ui.unmount();
    ui.cleanup();
  }
});

it.each(["\x1a", "\x1b[122;5u", "\x1b[27;5;122~", "\x1bq", "\x1b[113;3u"])("accepts portable queue-toggle and legacy alias encoding %j", async (data) => {
  const h = withQueue(["keep queued"]);
  h.wiring.handleData(data);
  await vi.waitFor(() => expect(h.wiring.getSnapshot().queueVisible).toBe(false));
  expect(h.services.session.getState().queued).toEqual(["keep queued"]);
});

it.each(["\x1a", "\x1bq"])("does not interpret queue-toggle bytes %j inside a bracketed paste as a visibility action", async (data) => {
  const h = withQueue(["keep queued"]);
  h.wiring.handleData(`\x1b[200~pasted ${data} content\x1b[201~`);
  await vi.waitFor(() => expect(h.wiring.getSnapshot().composer.state.text).toContain("pasted"));
  expect(h.wiring.queueVisibleValue).toBe(true);
  expect(h.services.session.getState().queued).toEqual(["keep queued"]);
});

it("keeps Option-produced text and existing Control editing shortcuts independent of the queue toggle", async () => {
  const h = withQueue(["keep queued"]);
  h.wiring.handleData("œ");
  await vi.waitFor(() => expect(h.wiring.composer.text).toBe("œ"));
  expect(h.wiring.queueVisibleValue).toBe(true);
  toggle(h);
  await vi.waitFor(() => expect(h.wiring.queueVisibleValue).toBe(false));
  h.wiring.composer.setText("abc");
  h.wiring.handleData("\x02");
  expect(h.wiring.composer.getSnapshot().state.cursor).toBe(2);
  h.wiring.handleData("\x06");
  expect(h.wiring.composer.getSnapshot().state.cursor).toBe(3);
  h.wiring.handleData("\x11");
  expect(h.wiring.composer.text).toBe("");
  expect(h.wiring.queueVisibleValue).toBe(false);
  expect(h.services.session.getState().queued).toEqual(["keep queued"]);
});
