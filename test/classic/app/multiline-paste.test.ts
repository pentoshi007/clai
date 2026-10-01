import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PASTE_BURST_SETTLE_MS,
  PASTE_END,
  PASTE_START,
  PASTE_TIMEOUT_MS,
} from "../../../src/classic/input/terminal-sequences.js";
import { createHarness, type Harness } from "./harness.js";

let harness: Harness | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  harness = createHarness({ agent: { runTurn: async () => "" } });
});

afterEach(() => {
  harness?.dispose();
  harness = undefined;
  vi.useRealTimers();
});

const PROMPT = ["first line", "second line", "", "fourth line"];

function nothingWasSent(h: Harness): void {
  const state = h.services.session.getState();
  expect(state.running).toBe(false);
  expect(state.queued).toEqual([]);
}

describe("pasting multiple lines", () => {
  it("lands in the composer as one draft when the terminal sends no paste markers", async () => {
    const { wiring } = harness!;
    wiring.handleData(PROMPT.join("\r"));
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(wiring.composer.text).toBe(PROMPT.join("\n"));
    nothingWasSent(harness!);
  });

  it("stays one draft when the terminal delivers the paste in small pieces", async () => {
    const { wiring } = harness!;
    for (const piece of ["first li", "ne\rsec", "ond line\r", "\rfourth", " line"]) {
      wiring.handleData(piece);
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(wiring.composer.text).toBe(PROMPT.join("\n"));
    nothingWasSent(harness!);
  });

  it("stays one draft when the lines trickle in far slower than a local terminal would deliver them", async () => {
    const { wiring } = harness!;
    for (const piece of PROMPT.map((line) => `${line}\r`)) {
      wiring.handleData(piece);
      await vi.advanceTimersByTimeAsync(120);
    }
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(wiring.composer.text).toBe(`${PROMPT.join("\n")}\n`);
    nothingWasSent(harness!);
  });

  it("stays one draft when each Enter arrives ahead of its line, blank lines included", async () => {
    const { wiring } = harness!;
    const pieces = PROMPT.map((line, index) => (index === 0 ? line : `\r${line}`));
    for (const piece of pieces) {
      wiring.handleData(piece);
      await vi.advanceTimersByTimeAsync(120);
    }
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(wiring.composer.text).toBe(PROMPT.join("\n"));
    nothingWasSent(harness!);
  });

  it("does not send a line whose Enter is delivered on its own a moment later", async () => {
    const { wiring } = harness!;
    wiring.handleData("first line");
    await vi.advanceTimersByTimeAsync(10);
    wiring.handleData("\r");
    await vi.advanceTimersByTimeAsync(10);
    wiring.handleData("second line");
    await vi.advanceTimersByTimeAsync(PASTE_BURST_SETTLE_MS + 50);
    expect(wiring.composer.text).toBe("first line\nsecond line");
    nothingWasSent(harness!);
  });

  it("still sends a line the user types and confirms with Enter", async () => {
    const { wiring } = harness!;
    wiring.handleData("hello");
    await vi.advanceTimersByTimeAsync(400);
    expect(wiring.composer.text).toBe("hello");
    wiring.handleData("\r");
    await vi.advanceTimersByTimeAsync(50);
    expect(wiring.composer.text).toBe("");
  });

  it("sends a pasted line followed by a deliberate Enter", async () => {
    const { wiring } = harness!;
    wiring.handleData(`${PASTE_START}one\ntwo${PASTE_END}`);
    expect(wiring.composer.text).toBe("one\ntwo");
    await vi.advanceTimersByTimeAsync(400);
    wiring.handleData("\r");
    await vi.advanceTimersByTimeAsync(50);
    expect(wiring.composer.text).toBe("");
  });

  it("keeps a bracketed paste whole across a network stall", async () => {
    const { wiring } = harness!;
    wiring.handleData(`${PASTE_START}one\ntwo\n`);
    await vi.advanceTimersByTimeAsync(PASTE_TIMEOUT_MS - 100);
    expect(wiring.composer.text).toBe("");
    wiring.handleData(`three${PASTE_END}`);
    expect(wiring.composer.text).toBe("one\ntwo\nthree");
    nothingWasSent(harness!);
  });
});
