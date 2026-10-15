import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { EventSequencer, createCountingIdFactory } from "../../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../../src/app/events/app-event.js";
import type { MouseEvent } from "../../../src/classic/input/key-event.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;
let seq: EventSequencer;
afterEach(() => { ui?.unmount(); ui?.cleanup(); ui = undefined; h?.dispose(); h = undefined; });

function append(index: number): void {
  h!.emit(seq.build("assistant-message", { messageId: asMessageId(`message-${index}`), text: `MESSAGE_${index}\nbody ${index}\nEND_${index}` }, asTurnId("turn-jump")));
}

async function setup(columns = 100): Promise<void> {
  h = createHarness({ columns, rows: 28 });
  seq = new EventSequencer(asSessionId("jump-fixture"), createCountingIdFactory("jump"));
  for (let index = 0; index < 40; index += 1) append(index);
  h.wiring.composer.setText("draft preserved");
  ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
  await vi.waitFor(() => expect(ui!.lastFrame()).toContain("END_39"));
}

function mouse(x: number, y: number, options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: "left", x, y, release: false, drag: false, scroll: undefined, ctrl: false, alt: false, shift: false, ...options };
}

function control(): { left: number; top: number; width: number } {
  const region = h!.wiring.jumpToLatestHitRegion;
  expect(region).toBeDefined();
  const row = ui!.lastFrame()!.split("\n")[region!.top]!;
  expect(row.slice(region!.left, region!.left + region!.width)).toMatch(/Latest|latest/);
  return region!;
}

async function scrollUp(): Promise<void> {
  h!.wiring.scrollFeed(30);
  await vi.waitFor(() => expect(ui!.lastFrame()).toMatch(/\[↓ (?:Jump to latest|Latest)\]/));
}

function click(region = control()): void {
  h!.wiring.handleMouse(mouse(region.left + 1, region.top));
  h!.wiring.handleMouse(mouse(region.left + 1, region.top, { release: true }));
}

describe("Classic jump-to-latest interaction", () => {
  it.each([40, 80, 120])("jumps to the true latest message and resumes following at %i columns", async columns => {
    await setup(columns);
    expect(h!.wiring.jumpToLatestHitRegion).toBeUndefined();
    await scrollUp();
    append(40);
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeDefined());
    click();
    await vi.waitFor(() => expect(ui!.lastFrame()).toContain("END_40"));
    expect(h!.wiring.liveOffsetValue).toBe(0);
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeUndefined());
    expect(ui!.lastFrame()).not.toContain("Jump to latest");
    append(41);
    await vi.waitFor(() => expect(ui!.lastFrame()).toContain("END_41"));
    expect(h!.wiring.composer.text).toBe("draft preserved");
    expect(h!.services.focus.activeContext()).toBe("composer");
  });

  it("ignores drags, released-outside presses and non-left clicks", async () => {
    await setup();
    await scrollUp();
    const target = control();
    const offset = h!.wiring.liveOffsetValue;
    h!.wiring.handleMouse(mouse(target.left, target.top, { button: "right" }));
    h!.wiring.handleMouse(mouse(target.left, target.top, { release: true }));
    expect(h!.wiring.liveOffsetValue).toBe(offset);
    h!.wiring.handleMouse(mouse(target.left, target.top));
    h!.wiring.handleMouse(mouse(target.left + 1, target.top, { drag: true }));
    h!.wiring.handleMouse(mouse(target.left + 1, target.top, { release: true }));
    expect(h!.wiring.liveOffsetValue).toBe(offset);
    h!.wiring.handleMouse(mouse(target.left, target.top));
    h!.wiring.handleMouse(mouse(0, target.top, { release: true }));
    expect(h!.wiring.liveOffsetValue).toBe(offset);
  });

  it("hides behind overlays and preserves the Ctrl+D keyboard fallback", async () => {
    await setup();
    await scrollUp();
    const target = control();
    const offset = h!.wiring.liveOffsetValue;
    h!.services.overlay.openPager("overlay", "body");
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeUndefined());
    click(target);
    expect(h!.wiring.liveOffsetValue).toBe(offset);
    h!.services.overlay.close();
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeDefined());
    h!.wiring.handleData("\x04");
    await vi.waitFor(() => expect(h!.wiring.liveOffsetValue).toBe(0));
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeUndefined());
  });

  it("clears its hit target on unmount", async () => {
    await setup();
    await scrollUp();
    control();
    ui!.unmount();
    await vi.waitFor(() => expect(h!.wiring.jumpToLatestHitRegion).toBeUndefined());
  });
});
