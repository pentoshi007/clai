import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asMessageId,
  asSessionId,
  asTurnId,
} from "../../../src/app/events/app-event.js";
import {
  createCountingIdFactory,
  EventSequencer,
} from "../../../src/app/events/sequencer.js";
import type { ActionId } from "../../../src/ui-core/actions/action-id.js";
import { keyEvent, type MouseEvent } from "../../../src/classic/input/key-event.js";
import type { FeedBlock } from "../../../src/classic/feed/feed-blocks.js";
import { flattenBlocks, planTranscriptWindow } from "../../../src/classic/feed/transcript-window.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

afterEach(() => {
  harness?.dispose();
  harness = undefined;
});

const KEY = { text: "" };

function mouse(overrides: Partial<MouseEvent>): MouseEvent {
  return {
    button: "left",
    x: 0,
    y: 0,
    release: false,
    drag: false,
    scroll: undefined,
    ctrl: false,
    alt: false,
    shift: false,
    ...overrides,
  };
}

function act(action: ActionId, chord = ""): void {
  harness!.wiring.actions.handle(action, chord, KEY);
}

interface SeededTurn {
  readonly userId: string;
  readonly assistantId: string;
}

function fakeFeed(
  lastItemId: string,
  geometry: { totalRows?: number; viewportRows?: number } = {},
): never {
  const totalRows = geometry.totalRows ?? 1;
  const viewportRows = geometry.viewportRows ?? totalRows;
  const rows = Array.from({ length: Math.min(totalRows, viewportRows) }, (_, i) => ({
    key: `r${i}`,
    line: "",
    block: { itemId: lastItemId },
  }));
  return {
    columns: 96,
    generation: 0,
    blocks: [{ itemId: lastItemId }],
    window: {
      rows,
      height: rows.length,
      totalRows,
      maxOffset: Math.max(0, totalRows - viewportRows),
      offset: 0,
      scrollAbove: Math.max(0, totalRows - viewportRows),
      scrollBelow: 0,
      viewportRows,
      firstItemId: lastItemId,
      lastItemId,
      visibleItemIds: new Set([lastItemId]),
    },
  } as never;
}

function seedTurn(): SeededTurn {
  const seq = new EventSequencer(
    asSessionId("sess-classic"),
    createCountingIdFactory("e"),
  );
  const turnId = asTurnId("turn-1");
  harness!.emit(seq.build("turn-started", { prompt: "hello there" }, turnId));
  harness!.emit(seq.build("assistant-delta", { text: "general answer" }, turnId));
  harness!.emit(
    seq.build(
      "assistant-message",
      { messageId: asMessageId("m-1"), text: "general answer" },
      turnId,
    ),
  );
  const state = harness!.services.transcript.getState();
  const userId = state.order.find((id) => state.byId.get(id)?.kind === "user");
  const assistantId = state.order.find(
    (id) => state.byId.get(id)?.kind === "assistant",
  );
  expect(userId).toBeDefined();
  expect(assistantId).toBeDefined();
  return { userId: userId!, assistantId: assistantId! };
}

describe("feed world remapping (03-RENDER-MODEL §10)", () => {
  it("redirects scrolling to terminal scrollback while the tail is not clipped", () => {
    harness = createHarness();
    act("transcript.scroll-up");
    const messages = harness.toastTexts().join(" ");
    expect(messages).toContain("Ctrl+R");
  });

  it("emits the scrollback hint only once", () => {
    harness = createHarness();
    act("transcript.scroll-up");
    act("transcript.scroll-down");
    act("transcript.page-up");
    act("transcript.page-down");
    const hints = harness
      .toastTexts()
      .filter((text) => text.includes("Ctrl+R"));
    expect(hints).toHaveLength(1);
  });

  it("points transcript.top at search and history instead of scrolling", () => {
    harness = createHarness();
    act("transcript.top");
    expect(harness.toastTexts().join(" ")).toContain("Ctrl+D");
  });

  it("treats transcript.bottom as a no-op because classic follows the tail", () => {
    harness = createHarness();
    const before = harness.wiring.getSnapshot();
    act("transcript.bottom");
    const after = harness.wiring.getSnapshot();
    expect(after.liveOffset).toBe(before.liveOffset);
    expect(harness.toastTexts()).toHaveLength(0);
    expect(harness.services.overlay.getState().kind).toBe("none");
  });

  it("opens the search panel and captures transcript-search focus", () => {
    harness = createHarness();
    act("transcript.search", "ctrl+r");
    expect(harness.wiring.panels.getSnapshot().search).toBeDefined();
    expect(harness.services.focus.activeContext()).toBe("transcript-search");
  });

  it("restores focus when the search panel closes", () => {
    harness = createHarness();
    act("transcript.search", "ctrl+r");
    harness.wiring.panels.closeSearch();
    expect(harness.wiring.panels.getSnapshot().search).toBeUndefined();
    expect(harness.services.focus.activeContext()).toBe("composer");
  });

  it("toggles thinking globally and reports the new state", () => {
    harness = createHarness();
    act("transcript.toggle-thinking", "ctrl+t");
    expect(harness.services.transcript.getState().expandThinkingGlobal).toBe(true);
    expect(harness.toastTexts().join(" ")).toContain("Thinking");
  });

  it("falls back to the shared /output flow when no output card exists", async () => {
    harness = createHarness();
    const dispatch = vi.spyOn(harness.services.commands, "dispatch");
    act("transcript.toggle-output", "ctrl+o");
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalled();
    expect(dispatch.mock.calls[0]?.[0]?.name).toBe("output");
  });

  it("expands an inline-expandable block instead of opening a pager", () => {
    harness = createHarness();
    const seq = new EventSequencer(
      asSessionId("sess-classic"),
      createCountingIdFactory("e"),
    );
    const turnId = asTurnId("turn-thinking");
    harness.emit(seq.build("turn-started", { prompt: "think" }, turnId));
    harness.emit(seq.build("thinking-delta", { text: "reasoning trace" }, turnId));
    const state = harness.services.transcript.getState();
    const thinkingId = state.order.find(
      (id) => state.byId.get(id)?.kind === "thinking",
    );
    expect(thinkingId).toBeDefined();
    harness.wiring.observeFeed(fakeFeed(thinkingId!));
    act("transcript.expand-toggle");
    expect(
      harness.services.transcript.getState().itemOverrides.has(thinkingId!),
    ).toBe(true);
    expect(harness.services.overlay.getState().kind).toBe("none");
  });

  it("opens a response block in a pager rather than overriding it", () => {
    harness = createHarness();
    const { assistantId } = seedTurn();
    harness.wiring.observeFeed(fakeFeed(assistantId));
    act("transcript.expand-toggle");
    expect(harness.services.overlay.getState().kind).toBe("pager");
  });

  it("does not rebuild the semantic document during streaming bursts", () => {
    vi.useFakeTimers();
    harness = createHarness();
    const seq = new EventSequencer(
      asSessionId("sess-classic"),
      createCountingIdFactory("e"),
    );
    const turnId = asTurnId("turn-burst");
    harness.emit(seq.build("turn-started", { prompt: "burst" }, turnId));
    const setDocument = vi.spyOn(harness.services.selection, "setDocument");

    for (let index = 0; index < 100; index += 1) {
      harness.emit(seq.build("assistant-delta", { text: `token-${index} ` }, turnId));
    }
    vi.advanceTimersByTime(16);

    expect(setDocument).not.toHaveBeenCalled();
    harness.dispose();
    harness = undefined;
    vi.useRealTimers();
  });

  it("selects the latest transcript through the selection controller", () => {
    harness = createHarness();
    seedTurn();
    const selectAll = vi.spyOn(harness.services.selection, "selectAll");
    act("selection.select-all");
    expect(selectAll).toHaveBeenCalledWith("transcript");
    expect(harness.services.selection.selectedText()).toContain("general answer");
  });

  it("copies the latest transcript through the clipboard port", async () => {
    harness = createHarness();
    seedTurn();
    const write = vi.spyOn(harness.services.ports.clipboard, "writeText");
    act("selection.copy", "ctrl+shift+c");
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(write.mock.calls[0]?.[0]).toContain("hello there");
    expect(write.mock.calls[0]?.[0]).toContain("general answer");
  });

  it("continues an existing draft when printable input arrives from transcript focus", async () => {
    harness = createHarness();
    harness.wiring.composer.setText("partial ");
    harness.services.focus.focusRegion("transcript");

    harness.wiring.router.handle({ type: "key", key: keyEvent("r", {}, "remaining") });

    expect(harness.services.focus.activeContext()).toBe("composer");
    await vi.waitFor(() =>
      expect(harness!.wiring.getSnapshot().composer.state.text).toBe("partial remaining"),
    );
  });

  it("copies a non-empty mouse drag and leaves ordinary clicks uncopied", async () => {
    harness = createHarness();
    const block: FeedBlock = {
      key: "0:a",
      itemId: "a",
      kind: "assistant",
      open: false,
      lines: ["alpha bravo", "charlie delta"],
      turnId: undefined,
      sequence: 0,
    };
    const flat = flattenBlocks([block]);
    const window = planTranscriptWindow(flat, 2, 0);
    harness.wiring.observeFeed({
      columns: 96,
      generation: 0,
      blocks: [block],
      window,
    } as never);
    harness.wiring.setTranscriptSelectionGeometry({ left: 2, top: 1 });
    const write = vi.spyOn(harness.services.ports.clipboard, "writeText");

    harness.wiring.handleMouse(mouse({ x: 3, y: 1 }));
    harness.wiring.handleMouse(mouse({ x: 7, y: 1, drag: true }));
    harness.wiring.handleMouse(mouse({ x: 7, y: 1, release: true }));
    await vi.waitFor(() => expect(write).toHaveBeenCalledWith("lpha"));
    await vi.waitFor(() => expect(harness!.toastTexts()).toContain("Copied selection"));
    expect(harness.services.focus.activeContext()).toBe("composer");
    harness.wiring.router.handle({ type: "key", key: keyEvent("x", {}, "x") });
    await vi.waitFor(() => expect(harness!.wiring.getSnapshot().composer.state.text).toBe("x"));

    write.mockClear();
    harness.wiring.handleMouse(mouse({ x: 4, y: 2 }));
    harness.wiring.handleMouse(mouse({ x: 4, y: 2, release: true }));
    await Promise.resolve();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps selecting while a drag autoscrolls above and below the viewport", () => {
    vi.useFakeTimers();
    harness = createHarness();
    const block: FeedBlock = {
      key: "0:a",
      itemId: "a",
      kind: "assistant",
      open: false,
      lines: Array.from({ length: 20 }, (_, index) => `line-${index}`),
      turnId: undefined,
      sequence: 0,
    };
    const window = planTranscriptWindow(flattenBlocks([block]), 5, 5);
    harness.wiring.observeFeed({ columns: 96, generation: 0, blocks: [block], window } as never);
    harness.wiring.setTranscriptSelectionGeometry({ left: 0, top: 2 });
    harness.wiring.handleMouse(mouse({ x: 0, y: 3 }));
    harness.wiring.handleMouse(mouse({ x: 4, y: 2, drag: true }));
    vi.advanceTimersByTime(120);
    expect(harness.wiring.getSnapshot().liveOffset).toBeGreaterThan(5);
    expect(harness.services.selection.getState().dragging).toBe(true);

    harness.wiring.handleMouse(mouse({ x: 4, y: 8, drag: true }));
    vi.advanceTimersByTime(120);
    expect(harness.wiring.getSnapshot().liveOffset).toBeLessThanOrEqual(harness.wiring.maxLiveOffset);
    harness.wiring.handleMouse(mouse({ x: 4, y: 8, release: true }));
    expect(harness.wiring.selectionAutoScrollTimer).toBeUndefined();
    vi.useRealTimers();
  });

  it("scrolls internally once the transcript overflows the viewport", async () => {
    harness = createHarness();
    const { userId, assistantId } = seedTurn();
    harness.wiring.observeFeed(fakeFeed(assistantId, { totalRows: 40, viewportRows: 12 }));
    act("transcript.scroll-up");
    await vi.waitFor(() =>
      expect(harness!.wiring.getSnapshot().liveOffset).toBeGreaterThan(0),
    );
    expect(harness.toastTexts().join(" ")).not.toContain("Ctrl+R");
    harness.wiring.scrollFeed(-Number.MAX_SAFE_INTEGER);
    await vi.waitFor(() =>
      expect(harness!.wiring.getSnapshot().liveOffset).toBe(0),
    );
  });

  it("pins the viewport to the same rows while content grows, until scrolled home", async () => {
    harness = createHarness();
    seedTurn();
    harness.wiring.observeFeed(fakeFeed("a", { totalRows: 40, viewportRows: 10 }));
    harness.wiring.scrollFeed(5);
    await vi.waitFor(() =>
      expect(harness!.wiring.getSnapshot().liveOffset).toBe(5),
    );
    harness.wiring.observeFeed(fakeFeed("a", { totalRows: 46, viewportRows: 10 }));
    harness.wiring.schedulePaint();
    await vi.waitFor(() =>
      expect(harness!.wiring.getSnapshot().liveOffset).toBe(11),
    );
  });
});
