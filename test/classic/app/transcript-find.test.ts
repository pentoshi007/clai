import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { ClassicApp } from "../../../src/classic/app/ClassicApp.js";
import { ServicesProvider } from "../../../src/ui-core/react/providers.js";
import { EventSequencer, createCountingIdFactory } from "../../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../../src/app/events/app-event.js";
import { stripAnsi } from "../../../src/classic/render/measure.js";
import { PASTE_END, PASTE_START } from "../../../src/classic/input/terminal-sequences.js";
import { createHarness, type Harness } from "./harness.js";

let h: Harness | undefined;
let ui: ReturnType<typeof render> | undefined;

afterEach(() => {
  ui?.unmount();
  ui?.cleanup();
  ui = undefined;
  h?.dispose();
  h = undefined;
});

function frame(): string {
  return stripAnsi(ui!.lastFrame() ?? "");
}

async function waitForFrame(text: string): Promise<void> {
  await vi.waitFor(() => expect(frame()).toContain(text));
}

async function setup(): Promise<void> {
  h = createHarness({ columns: 100, rows: 30 });
  const seq = new EventSequencer(asSessionId("find-fixture"), createCountingIdFactory("find"));
  for (let index = 0; index < 60; index += 1) {
    const turn = asTurnId(`turn-${index}`);
    if (index === 15) {
      h.emit(seq.build("turn-started", { prompt: "please find the Needle in prompt fifteen" }, turn));
      continue;
    }
    const text = index === 5
      ? "alpha NEEDLE_5 omega"
      : index === 30
        ? "first NEEDLE_30A then\nsecond NEEDLE_30B done"
        : index === 58
          ? "latest NEEDLE_58 here"
          : `filler message ${index}`;
    h.emit(seq.build("assistant-message", { messageId: asMessageId(`message-${index}`), text: `${text}\nEND_${index}` }, turn));
  }
  ui = render(createElement(ServicesProvider, { services: h.services, children: createElement(ClassicApp, { wiring: h.wiring }) }));
  await waitForFrame("END_59");
}

function send(data: string): void {
  h!.wiring.handleData(data);
}

async function escape(): Promise<void> {
  send("\x1b");
  await new Promise((resolve) => setTimeout(resolve, 80));
}

function type(text: string): void {
  for (const char of text) send(char);
}

function active(): number {
  return h!.wiring.find.activeIndex();
}

describe("Classic transcript find", () => {
  it("opens from the composer, highlights in place and steps through every match", async () => {
    await setup();
    expect(h!.services.focus.activeContext()).toBe("composer");
    send("\x12");
    await waitForFrame("Find in transcript");
    expect(h!.services.focus.activeContext()).toBe("transcript-search");

    type("needle");
    await waitForFrame("5/5");
    await waitForFrame("NEEDLE_58");
    expect(h!.wiring.composer.text).toBe("");

    send("\x1b[A");
    await waitForFrame("4/5");
    await waitForFrame("NEEDLE_30B");
    expect(active()).toBe(3);

    send("\x12");
    await waitForFrame("3/5");
    await waitForFrame("NEEDLE_30A");

    send("\x1b[A");
    await waitForFrame("2/5");
    await waitForFrame("prompt fifteen");

    send("\x1b[A");
    await waitForFrame("1/5");
    await waitForFrame("NEEDLE_5 ");

    send("\x1b[A");
    await waitForFrame("5/5");
    await waitForFrame("NEEDLE_58");

    send("\x1b[B");
    await waitForFrame("1/5");

    send("\r");
    await waitForFrame("n next");
    expect(h!.services.focus.activeContext()).toBe("transcript");

    send("n");
    await waitForFrame("2/5");
    await waitForFrame("prompt fifteen");
    send("N");
    await waitForFrame("1/5");
    expect(h!.wiring.composer.text).toBe("");

    send("\x1b");
    await vi.waitFor(() => expect(frame()).not.toContain("Find in transcript"));
    expect(h!.wiring.find.getSnapshot().open).toBe(false);
  });

  it("refines the query around the current match and reports empty results", async () => {
    await setup();
    send("\x12");
    type("needle_30");
    await waitForFrame("2/2");
    type("b");
    await waitForFrame("1/1");
    await waitForFrame("NEEDLE_30B");
    send("\x7f");
    await waitForFrame("2/2");
    type("zz");
    await waitForFrame("no matches");
    send("\x15");
    await vi.waitFor(() => expect(h!.wiring.find.getSnapshot().query).toBe(""));
    send(`${PASTE_START}latest   needle${PASTE_END}`);
    await waitForFrame("1/1");
    expect(h!.wiring.find.getSnapshot().query).toBe("latest needle");
    expect(h!.wiring.composer.text).toBe("");
    send("\x1b");
    await vi.waitFor(() => expect(frame()).not.toContain("Find in transcript"));
    expect(h!.services.focus.activeContext()).toBe("composer");
  });

  it("returns typing to the composer once the search is accepted", async () => {
    await setup();
    send("\x12");
    type("needle");
    await waitForFrame("5/5");
    send("\r");
    await waitForFrame("n next");
    type("x");
    await vi.waitFor(() => expect(h!.wiring.composer.text).toBe("x"));
    type("n");
    await vi.waitFor(() => expect(h!.wiring.composer.text).toBe("xn"));
    expect(active()).toBe(4);
    send("\x12");
    await waitForFrame("^R prev");
    expect(h!.wiring.find.getSnapshot().query).toBe("needle");
  });

  it("keeps the pager open while Escape backs out of its find prompt and query", async () => {
    h = createHarness({ columns: 100, rows: 30 });
    const body = Array.from({ length: 80 }, (_, index) => (index % 20 === 7 ? `target row ${index}` : `plain row ${index}`)).join("\n");
    h.services.overlay.openPager("Output", body, undefined, undefined, "plain");
    const pager = () => h!.wiring.panels.getSnapshot().pager;
    send("\x12");
    expect(pager().finding).toBe(true);
    type("target");
    expect(pager()).toMatchObject({ draft: "target", matchIndex: 0, caret: 7 });
    send("\x1b[B");
    expect(pager()).toMatchObject({ matchIndex: 1, caret: 27 });
    send("q");
    expect(pager().draft).toBe("targetq");
    send("\x7f");
    send("\r");
    expect(pager()).toMatchObject({ finding: false, query: "target", matchIndex: 1, caret: 27 });
    send("n");
    expect(pager().caret).toBe(47);
    send("\x12");
    await escape();
    expect(pager()).toMatchObject({ finding: false, query: "target" });
    expect(h.services.overlay.getState().kind).toBe("pager");
    await escape();
    expect(pager().query).toBe("");
    expect(h.services.overlay.getState().kind).toBe("pager");
    await escape();
    expect(h.services.overlay.getState().kind).toBe("none");
  });

  it("yields its focus to blocking prompts without losing the query", async () => {
    await setup();
    send("\x12");
    type("needle");
    await waitForFrame("5/5");
    h!.services.overlay.openPager("Output", "body");
    await vi.waitFor(() => expect(h!.services.focus.activeContext()).toBe("pager"));
    expect(h!.wiring.find.getSnapshot()).toMatchObject({ open: true, editing: false, query: "needle" });
    h!.services.overlay.close();
    await vi.waitFor(() => expect(h!.services.focus.activeContext()).not.toBe("pager"));
    await waitForFrame("5/5");
  });
});
