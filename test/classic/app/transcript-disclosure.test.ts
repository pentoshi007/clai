import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { blockContextFor, buildFeedBlocks } from "../../../src/classic/feed/feed-blocks.js";
import { planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import { disclosureAtPointer } from "../../../src/classic/feed/transcript-disclosure.js";
import { keyEvent, type MouseEvent } from "../../../src/classic/input/key-event.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { transcriptItems, type TranscriptItem } from "../../../src/ui-core/state/transcript-types.js";
import { feedView, scriptedTurn } from "../feed/fixture.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness | undefined;
afterEach(() => { h?.dispose(); h = undefined; });

function mouse(x: number, y: number, options: Partial<MouseEvent> = {}): MouseEvent {
  return { button: "left", x, y, release: false, drag: false, scroll: undefined, ctrl: false, alt: false, shift: false, ...options };
}

function setup(options: { columns?: number; rows?: number; offset?: number; item?: TranscriptItem } = {}) {
  h = createHarness({ columns: options.columns ?? 100, rows: options.rows ?? 60 });
  const turn = scriptedTurn();
  const items = options.item ? [options.item] : transcriptItems(turn.state).filter((item) => item.kind === "tool" && item.name === "shell.exec");
  h.services.transcript.hydrate({ ...turn.state, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) });
  for (const item of items) if (item.kind === "tool") h.services.session.spool.replace(item.toolCallId, Array.from({ length: 8 }, (_, i) => `OUTPUT_${i}`).join("\n"));
  const refresh = (columns = options.columns ?? 100, offset = options.offset ?? 0) => {
    const state = h!.services.transcript.getState();
    const view = { ...feedView(turn, { columns }), spool: h!.services.session.spool };
    const blocks = buildFeedBlocks(state, view);
    const window = planTranscriptWindow(blocks, options.rows ?? 60, offset);
    h!.wiring.observeFeed({ ink: view.ink, context: blockContextFor(state, view), blocks, window, columns, generation: h!.wiring.feedGenerationValue, navigationVersion: h!.wiring.feedNavigationVersion, requestedOffset: h!.wiring.liveOffsetValue });
    h!.wiring.setTranscriptSelectionGeometry({ left: 2, top: 3 });
    return window;
  };
  return { turn, items, refresh, window: refresh() };
}

function point(window: ReturnType<typeof planTranscriptWindow>, itemId: string) {
  const y = window.rows.findIndex((row) => row.block.itemId === itemId && row.block.disclosures?.some((entry) => entry.lineIndex === row.lineIndex));
  expect(y).toBeGreaterThanOrEqual(0);
  const row = window.rows[y]!;
  const link = row.block.disclosures!.find((entry) => entry.lineIndex === row.lineIndex)!;
  return { x: 2 + link.column, y: 3 + y, width: link.width };
}

function click(x: number, y: number) {
  h!.wiring.handleMouse(mouse(x, y));
  h!.wiring.handleMouse(mouse(x, y, { release: true }));
}

describe("classic inline transcript disclosures", () => {
  it("toggles only the clicked item and preserves composer, focus, selection and stored output", () => {
    const { items, window, refresh } = setup();
    h!.wiring.composer.setText("kept draft");
    h!.services.selection.selectAll("transcript");
    const selection = h!.services.selection.selectedText();
    const item = items[0]!;
    const p = point(window, item.id);
    click(p.x, p.y);
    expect(h!.services.transcript.getState().itemOverrides.get(item.id)).toBe(true);
    expect(h!.services.transcript.getState().expandOutputGlobal).toBe(false);
    expect(h!.services.transcript.getState().itemOverrides.has(items[1]!.id)).toBe(false);
    expect(h!.wiring.composer.getSnapshot().state.text).toBe("kept draft");
    expect(h!.services.focus.activeContext()).toBe("composer");
    expect(h!.services.selection.selectedText()).toBe(selection);
    expect(h!.services.overlay.getState().kind).toBe("none");
    const expanded = refresh();
    expect(expanded.rows.map((row) => stripAnsi(row.line)).join("\n")).toContain("OUTPUT_7");
    const back = point(expanded, item.id);
    click(back.x, back.y);
    expect(h!.services.transcript.getState().itemOverrides.get(item.id)).toBe(false);
    expect(h!.services.transcript.getState().byId.get(item.id)).toEqual(item);
  });

  it("uses accurate disclosure coordinates after scrolling and resizing", () => {
    const { items, refresh } = setup({ rows: 8 });
    const window = refresh(44, 4);
    const p = point(window, items[0]!.id);
    expect(disclosureAtPointer(window, p.x, p.y, { left: 2, top: 3 })?.itemId).toBe(items[0]!.id);
    expect(disclosureAtPointer(window, p.x - 1, p.y, { left: 2, top: 3 })).toBeUndefined();
    expect(disclosureAtPointer(window, p.x + p.width, p.y, { left: 2, top: 3 })).toBeUndefined();
    click(p.x + p.width - 1, p.y);
    expect(h!.services.transcript.getState().itemOverrides.get(items[0]!.id)).toBe(true);
  });

  it("does not treat output text resembling a disclosure as a button", () => {
    const { items, refresh } = setup();
    const item = items[0]!;
    if (item.kind !== "tool") throw new Error("tool fixture");
    h!.services.session.spool.replace(item.toolCallId, "+ click to expand\nordinary output");
    const window = refresh();
    const index = window.rows.findIndex((row) => row.block.itemId === item.id && stripAnsi(row.line).includes("└ + click to expand"));
    click(6, 3 + index);
    expect(h!.services.transcript.getState().itemOverrides.has(item.id)).toBe(false);
  });

  it("ignores drag/release/non-left clicks and still scrolls the wheel", async () => {
    const { items, window } = setup({ rows: 8 });
    const p = point(window, items[1]!.id);
    for (const options of [{ drag: true }, { release: true }, { button: "right" as const }]) h!.wiring.handleMouse(mouse(p.x, p.y, options));
    expect(h!.services.transcript.getState().itemOverrides.size).toBe(0);
    h!.wiring.handleMouse(mouse(p.x, p.y, { scroll: "up" }));
    await vi.waitFor(() => expect(h!.wiring.liveOffsetValue).toBeGreaterThan(0));
  });

  it("suppresses selection drag after pressing an expansion control", () => {
    const { items, window } = setup();
    const p = point(window, items[0]!.id);
    h!.wiring.handleMouse(mouse(p.x, p.y));
    h!.wiring.handleMouse(mouse(p.x + 20, p.y + 2, { drag: true }));
    h!.wiring.handleMouse(mouse(p.x + 20, p.y + 2, { release: true }));
    expect(h!.services.focus.activeContext()).toBe("composer");
    expect(h!.services.selection.hasSelection()).toBe(false);
    expect(h!.services.transcript.getState().itemOverrides.get(items[0]!.id)).toBe(true);
  });

  it("does not activate transcript links behind overlays or captured context editing", () => {
    const { items, window } = setup();
    const p = point(window, items[0]!.id);
    h!.services.overlay.openPager("panel", "body");
    click(p.x, p.y);
    expect(h!.services.transcript.getState().itemOverrides.size).toBe(0);
    h!.wiring.closePanel();
    h!.wiring.startContextLimitEditing();
    click(p.x, p.y);
    expect(h!.services.transcript.getState().itemOverrides.size).toBe(0);
  });

  it.each(["user", "thinking", "tool", "compacted"] as const)("expands %s blocks in place", (kind) => {
    const turn = scriptedTurn();
    const original = transcriptItems(turn.state).find((item) => item.kind === kind)!;
    const item = kind === "user" && original.kind === "user" ? { ...original, text: Array.from({ length: 12 }, (_, i) => `PROMPT_${i}`).join("\n") } : original;
    const { window } = setup({ item });
    const p = point(window, item.id);
    click(p.x, p.y);
    expect(h!.services.transcript.getState().itemOverrides.get(item.id)).toBe(true);
    expect(h!.services.overlay.getState().kind).toBe("none");
  });

  it("routes standard SGR mouse bytes through the portable decoder and input router", () => {
    const { items, window } = setup();
    const p = point(window, items[0]!.id);
    const decoder = new RawDecoder({ mouse: true });
    const bytes = `\x1b[<0;${p.x + 1};${p.y + 1}M\x1b[<0;${p.x + 1};${p.y + 1}m`;
    for (const event of decoder.push(bytes)) h!.wiring.router.handle(event);
    expect(h!.services.transcript.getState().itemOverrides.get(items[0]!.id)).toBe(true);
    expect(h!.services.focus.activeContext()).toBe("composer");
    expect(new RawDecoder({ mouse: false }).push(bytes)).toEqual([]);
  });

  it("makes Ctrl+O expand all outputs after an individual card was re-collapsed", () => {
    const { items, window, refresh } = setup();
    const p = point(window, items[0]!.id);
    click(p.x, p.y);
    const expanded = refresh();
    const back = point(expanded, items[0]!.id);
    click(back.x, back.y);
    expect(h!.services.transcript.getState().itemOverrides.get(items[0]!.id)).toBe(false);
    h!.wiring.handleData("\x0f");
    expect(h!.services.transcript.getState().itemOverrides.has(items[0]!.id)).toBe(false);
    expect(h!.services.transcript.getState().expandOutputGlobal).toBe(true);
    h!.wiring.handleData("\x0f");
    expect(h!.services.transcript.getState().expandOutputGlobal).toBe(false);
  });

  it("offers keyboard expansion without mouse support", () => {
    const { items, refresh } = setup();
    h!.services.focus.focusRegion("transcript");
    h!.wiring.router.handle({ type: "key", key: keyEvent("enter") });
    expect(h!.services.transcript.getState().itemOverrides.get(items[1]!.id)).toBe(true);
    h!.wiring.handleData("\x0f");
    const text = refresh().rows.map((row) => stripAnsi(row.line)).join("\n");
    expect(text).toContain("OUTPUT_7");
    expect(h!.services.transcript.getState().expandOutputGlobal).toBe(true);
  });

  it("clicks the actual visible ClassicApp footer, then re-collapses it", async () => {
    setup({ rows: 60 });
    h!.wiring.composer.setText("unchanged draft");
    const ui = render(createElement(ServicesProvider, { services: h!.services, children: createElement(ClassicApp, { wiring: h!.wiring }) }));
    try {
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("+ click to expand"));
      const itemId = h!.wiring.selectionWindow!.rows.find((row) => row.block.kind === "tool")!.block.itemId;
      const visiblePoint = () => {
        const window = h!.wiring.selectionWindow!;
        const y = window.rows.findIndex((row) => row.block.itemId === itemId && row.block.disclosures?.some((entry) => entry.lineIndex === row.lineIndex));
        const row = window.rows[y]!;
        const link = row.block.disclosures!.find((entry) => entry.lineIndex === row.lineIndex)!;
        return { x: h!.wiring.selectionGeometry.left + link.column, y: h!.wiring.selectionGeometry.top + y };
      };
      const p = visiblePoint();
      click(p.x, p.y);
      await vi.waitFor(() => expect(ui.lastFrame()).toContain("OUTPUT_7"));
      const back = visiblePoint();
      click(back.x, back.y);
      await vi.waitFor(() => expect(ui.lastFrame()).not.toContain("OUTPUT_7"));
      expect(ui.lastFrame()).toContain("unchanged draft");
      expect(h!.services.overlay.getState().kind).toBe("none");
    } finally { ui.unmount(); ui.cleanup(); }
  });
});
