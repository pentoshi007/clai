import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { keyEvent, type MouseEvent } from "../../../src/classic/input/key-event.js";
import { buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import * as editorView from "../../../src/classic/chrome/editor-view.js";
import { createHarness, type Harness } from "./harness.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";

let h: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(() => { ui?.unmount(); ui?.cleanup(); ui = undefined; h?.dispose(); h = undefined; vi.useRealTimers(); });

function mouse(x: number, y: number, options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: "left", x, y, release: false, drag: false, scroll: undefined, ctrl: false, alt: false, shift: false, ...options };
}

function setup() {
  h = createHarness({ rows: 32, columns: 100 });
  const turn = scriptedTurn();
  const state = { ...turn.state, expandOutputGlobal: true };
  h.services.transcript.hydrate(state);
  const view = feedView(turn, { columns: 100 });
  const blocks = buildFeedBlocks(state, view);
  const window = planTranscriptWindow(blocks, 12, 0);
  h.wiring.observeFeed({ columns: 100, generation: h.wiring.feedGenerationValue, navigationVersion: h.wiring.feedNavigationVersion, requestedOffset: h.wiring.liveOffsetValue, ink: view.ink, context: {} as never, blocks, window });
  h.wiring.setTranscriptSelectionGeometry({ left: 0, top: 0 });
}

describe("classic scrolling and keyboard focus", () => {
  it("does not strand ordinary typing and editor shortcuts after a transcript click", () => {
    setup();
    h!.wiring.composer.setText("draft ");
    h!.wiring.handleMouse(mouse(2, 1));
    h!.wiring.handleMouse(mouse(2, 1, { release: true }));
    expect(h!.services.focus.activeContext()).toBe("composer");
    const offset = h!.wiring.liveOffsetValue;
    h!.wiring.router.handle({ type: "key", key: keyEvent("c", {}, "c") });
    expect(h!.wiring.composer.text).toBe("draft c");
    h!.wiring.router.handle({ type: "key", key: keyEvent("left") });
    h!.wiring.router.handle({ type: "key", key: keyEvent("backspace") });
    expect(h!.wiring.composer.text).toBe("draftc");
    expect(h!.wiring.liveOffsetValue).toBe(offset);
    h!.wiring.handleData("\x14");
    expect(h!.services.transcript.getState().expandThinkingGlobal).toBe(true);
  });

  it("stops orphaned mouse autoscroll when keyboard input resumes", () => {
    vi.useFakeTimers();
    setup();
    h!.wiring.handleMouse(mouse(1, 2));
    h!.wiring.handleMouse(mouse(3, 0, { drag: true }));
    expect(h!.wiring.selectionAutoScrollTimer).toBeDefined();
    h!.wiring.router.handle({ type: "key", key: keyEvent("x", {}, "x") });
    expect(h!.wiring.selectionAutoScrollTimer).toBeUndefined();
    expect(h!.services.selection.getState().dragging).toBe(false);
    const offset = h!.wiring.liveOffsetValue;
    vi.advanceTimersByTime(200);
    expect(h!.wiring.liveOffsetValue).toBe(offset);
    expect(h!.wiring.composer.text).toBe("x");
  });

  it("glides a wheel burst across paints without losing scroll distance or transcript content", async () => {
    vi.useFakeTimers();
    setup();
    const order = h!.services.transcript.getState().order;
    const offsets: number[] = [];
    h!.wiring.subscribe(() => offsets.push(h!.wiring.getSnapshot().liveOffset));
    for (let i = 0; i < 20; i += 1) h!.wiring.handleMouse(mouse(1, 1, { scroll: "up" }));
    expect(h!.wiring.liveOffsetValue).toBe(0);
    await vi.advanceTimersByTimeAsync(75);
    const expected = Math.min(h!.wiring.maxLiveOffset, 20);
    const steps = offsets.map((offset, i) => offset - (offsets[i - 1] ?? 0));
    expect(offsets.at(-1)).toBe(expected);
    expect(h!.wiring.wheel.active).toBe(false);
    expect(steps.filter((step) => step > 0).length).toBeGreaterThan(1);
    expect(steps.every((step) => step >= 0 && step <= 8)).toBe(true);
    expect(h!.services.transcript.getState().order).toBe(order);
    expect(h!.services.focus.activeContext()).toBe("composer");
  });

  it("keeps a slow VM paint cadence from turning a gesture into a long queue", async () => {
    vi.useFakeTimers();
    setup();
    await vi.advanceTimersByTimeAsync(100);
    h!.wiring.paintPacing = { costMs: 100, intervalMs: 250 };
    h!.wiring.lastPaintAt = Date.now();
    const offsets: number[] = [];
    h!.wiring.subscribe(() => offsets.push(h!.wiring.getSnapshot().liveOffset));
    for (let i = 0; i < 20; i += 1) h!.wiring.handleMouse(mouse(1, 1, { scroll: "up" }));
    await vi.advanceTimersByTimeAsync(34);
    expect(h!.wiring.liveOffsetValue).toBeGreaterThan(2);
    expect(h!.wiring.liveOffsetValue).toBeLessThan(20);
    await vi.advanceTimersByTimeAsync(50);
    expect(h!.wiring.liveOffsetValue).toBe(Math.min(h!.wiring.maxLiveOffset, 20));
    expect(h!.wiring.wheel.active).toBe(false);
    expect(offsets.length).toBeLessThanOrEqual(3);
  });

  it("discards the remaining gesture as soon as the transcript boundary is reached", async () => {
    vi.useFakeTimers();
    setup();
    h!.wiring.scrollFeed(3);
    await vi.advanceTimersByTimeAsync(100);
    for (let i = 0; i < 120; i += 1) h!.wiring.handleMouse(mouse(1, 1, { scroll: "down" }));
    await vi.advanceTimersByTimeAsync(75);
    expect(h!.wiring.liveOffsetValue).toBe(0);
    expect(h!.wiring.wheel.active).toBe(false);
    const offset = h!.wiring.liveOffsetValue;
    await vi.advanceTimersByTimeAsync(1000);
    expect(h!.wiring.liveOffsetValue).toBe(offset);
  });

  it("reuses unchanged session state during wheel paints and refreshes on notifications", async () => {
    vi.useFakeTimers();
    setup();
    await vi.advanceTimersByTimeAsync(100);
    const read = vi.spyOn(h!.services.session, "getState");
    const session = h!.wiring.getSnapshot().session;
    for (let i = 0; i < 20; i += 1) h!.wiring.handleMouse(mouse(1, 1, { scroll: "up" }));
    await vi.advanceTimersByTimeAsync(500);
    expect(read).not.toHaveBeenCalled();
    expect(h!.wiring.getSnapshot().session).toBe(session);
    h!.services.session.enqueue("queued while scrolling");
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalled();
    expect(h!.wiring.getSnapshot().session.queued).toHaveLength(1);
    read.mockClear();
    h!.services.transcript.toggleThinkingGlobal();
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalled();
  });

  it("cancels a wheel glide when the keyboard scrolls", async () => {
    vi.useFakeTimers();
    setup();
    for (let i = 0; i < 20; i += 1) h!.wiring.handleMouse(mouse(1, 1, { scroll: "up" }));
    await vi.advanceTimersByTimeAsync(20);
    const glided = h!.wiring.liveOffsetValue;
    expect(glided).toBeGreaterThan(0);
    h!.wiring.scrollFeed(-1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h!.wiring.liveOffsetValue).toBe(glided - 1);
  });

  it("does not re-layout a long unchanged composer for scroll-only frames", async () => {
    setup();
    const measure = vi.spyOn(editorView, "layoutEditor");
    h!.wiring.composer.setText("unchanged draft line\n".repeat(250));
    ui = render(createElement(ServicesProvider, { services: h!.services, children: createElement(ClassicApp, { wiring: h!.wiring }) }));
    await vi.waitFor(() => expect(ui!.lastFrame()).toContain("unchanged draft line"));
    measure.mockClear();
    for (let i = 0; i < 4; i += 1) {
      h!.wiring.scrollFeed(1);
      await vi.waitFor(() => expect(h!.wiring.getSnapshot().liveOffset).toBe(i + 1));
    }
    expect(measure).not.toHaveBeenCalled();
  });
});

describe("classic scrollbar-free viewport", () => {
  it("scrolls the transcript without drawing a track or thumb", async () => {
    setup();
    h!.wiring.composer.setText("draft");
    ui = render(createElement(ServicesProvider, { services: h!.services, children: createElement(ClassicApp, { wiring: h!.wiring }) }));
    await vi.waitFor(() => expect(ui!.lastFrame()).toContain("draft"));
    const beforeFrames = ui.frames.length;
    h!.wiring.scrollFeed(12);
    await vi.waitFor(() => expect(ui!.frames.length).toBeGreaterThan(beforeFrames));
    expect(h!.wiring.getSnapshot().liveOffset).toBe(12);
    expect(ui.lastFrame()!.split("\n").some((line) => /[▓█]$/.test(line))).toBe(false);
    expect(h!.services.focus.activeContext()).toBe("composer");
    expect(h!.wiring.composer.text).toBe("draft");
  });
});
