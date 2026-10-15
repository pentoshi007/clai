import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { keyEvent, type MouseEvent } from "../../../src/classic/input/key-event.js";
import { createHarness, type Harness } from "./harness.js";
import { horizontalPadding, innerShellWidth } from "../../../src/classic/render/shell-width.js";

let h: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;
afterEach(() => { ui?.unmount(); ui?.cleanup(); ui = undefined; h?.dispose(); h = undefined; });

function mouse(x: number, y: number, options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: "left", x, y, release: false, drag: false, scroll: undefined, ctrl: false, alt: false, shift: false, ...options };
}

async function setup(text: string, columns = 100, rows = 32) {
  h = createHarness({ columns, rows });
  h.wiring.composer.setText(text);
  ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
  await vi.waitFor(() => expect(ui!.lastFrame()).toContain(text.split("\n").at(-1)!));
}

function textPoint(needle: string, column = 0) {
  const lines = ui!.lastFrame()!.split("\n");
  const y = lines.findIndex((line) => line.includes(needle));
  expect(y).toBeGreaterThanOrEqual(0);
  return { x: lines[y]!.indexOf(needle) + column, y };
}

function click(x: number, y: number) {
  h!.wiring.handleMouse(mouse(x, y));
  h!.wiring.handleMouse(mouse(x, y, { release: true }));
}

describe("classic composer cursor clicks", () => {
  it.each([40, 80, 120])("positions the cursor from the actual rendered composer at %i columns", async (columns) => {
    await setup("alpha beta", columns);
    h!.services.focus.focusRegion("transcript");
    const point = textPoint("alpha beta", 2);
    click(point.x, point.y);
    expect(h!.services.focus.activeContext()).toBe("composer");
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(2);
    h!.wiring.router.handle({ type: "key", key: keyEvent("x", {}, "X") });
    expect(h!.wiring.composer.text).toBe("alXpha beta");
    expect(h!.services.selection.hasSelection()).toBe(false);
  });

  it("targets multiline rows and clamps trailing blank cells to line end", async () => {
    await setup("first\nsecond line\nthird");
    const point = textPoint("second line", 3);
    click(point.x, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(9);
    click(point.x + 30, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(17);
  });

  it("ignores non-left clicks, drag motion and composer clicks behind overlays", async () => {
    await setup("alpha beta");
    const point = textPoint("alpha beta", 2);
    for (const options of [{ button: "right" as const }, { drag: true }, { release: true }]) h!.wiring.handleMouse(mouse(point.x, point.y, options));
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(10);
    h!.services.overlay.openPager("blocked", "body");
    click(point.x, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(10);
    expect(h!.services.focus.activeContext()).toBe("pager");
  });
});

describe("composer pointer state boundaries", () => {
  it("keeps byte input, Unicode cursor offsets and subsequent keyboard editing aligned", async () => {
    await setup("a👨‍👩‍👧‍👦z");
    const point = textPoint("a👨‍👩‍👧‍👦z");
    click(point.x + 3, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(12);
    h!.wiring.handleData("\x7f");
    expect(h!.wiring.composer.text).toBe("az");
  });

  it("does not apply stale rendered offsets to newly typed text", async () => {
    await setup("alpha beta");
    const point = textPoint("alpha beta", 2);
    h!.wiring.composer.setText("new text waiting to paint");
    click(point.x, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(h!.wiring.composer.text.length);
    expect(h!.services.focus.activeContext()).toBe("composer");
  });

  it("clears hit geometry when unmounted", async () => {
    await setup("alpha beta");
    expect(h!.wiring.composerPointerView).toBeDefined();
    ui!.unmount();
    await vi.waitFor(() => expect(h!.wiring.composerPointerView).toBeUndefined());
  });
});

describe("classic transcript and composer alignment", () => {
  it.each([24, 28, 40, 80, 120])("spans the transcript shell without an extra inset at %i columns", async (columns) => {
    await setup("draft", columns, 52);
    const tops = ui!.lastFrame()!.split("\n").filter((line) => line.includes("╭"));
    expect(tops).toHaveLength(2);
    const card = tops[0]!;
    const composer = tops[1]!;
    expect(composer.indexOf("╭")).toBe(horizontalPadding(columns));
    expect(composer.lastIndexOf("╮")).toBe(columns - horizontalPadding(columns) - 1);
    expect(composer.indexOf("╭")).toBeLessThan(card.indexOf("╭"));
    expect(h!.wiring.composerPointerView!.layout.width).toBe(innerShellWidth(columns) - 5);
    const point = textPoint("draft", 2);
    click(point.x, point.y);
    expect(h!.wiring.composer.getSnapshot().state.cursor).toBe(2);
  });
});
