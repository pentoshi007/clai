import { describe, expect, it } from "vitest";
import { InputPipeline } from "../../../src/classic/input/input-pipeline.js";
import { PasteBurstAssembler } from "../../../src/classic/input/paste-burst.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import {
  ESCAPE_TIMEOUT_MS,
  PASTE_BURST_SETTLE_MS,
  PASTE_END,
  PASTE_START,
} from "../../../src/classic/input/terminal-sequences.js";

function build() {
  const clock = { now: 0 };
  const pipeline = new InputPipeline(
    new RawDecoder({ now: () => clock.now, bulkText: true }),
    new PasteBurstAssembler(),
    () => clock.now,
  );
  return { pipeline, clock };
}

describe("InputPipeline", () => {
  it("collects large single-line reads without materializing a key event for every grapheme", () => {
    const { pipeline, clock } = build();
    const text = `${"漢字 👩🏽‍💻 é JSON ".repeat(8000)}end`;
    expect(pipeline.push(text.slice(0, 4000))).toEqual([]);
    clock.now = 80;
    expect(pipeline.push(text.slice(4000))).toEqual([]);
    clock.now += PASTE_BURST_SETTLE_MS;
    expect(pipeline.flush()).toEqual([{ type: "paste", text }]);
    expect(pipeline.push("\u0003")).toEqual([
      { type: "key", key: expect.objectContaining({ name: "c", ctrl: true }) },
    ]);
  });

  it("retains a fragmented bracketed paste beyond one MiB without releasing its newlines as keys", () => {
    const { pipeline } = build();
    const first = "a\n".repeat(550_000);
    expect(pipeline.push(`${PASTE_START}${first}`)).toEqual([]);
    expect(pipeline.push(`tail\n${PASTE_END}`)).toEqual([
      { type: "paste", text: `${first}tail\n` },
    ]);
    expect(pipeline.pendingDeadline).toBeUndefined();
  });

  it("delivers a bracketed paste as a single paste event", () => {
    const { pipeline } = build();
    expect(pipeline.push(`${PASTE_START}a\nb${PASTE_END}`)).toEqual([
      { type: "paste", text: "a\nb" },
    ]);
    expect(pipeline.pendingDeadline).toBeUndefined();
  });

  it("delivers an unbracketed multi-line paste as a single paste event", () => {
    const { pipeline, clock } = build();
    expect(pipeline.push("first\rsecond\rthird\r")).toEqual([]);
    expect(pipeline.pendingDeadline).toBe(PASTE_BURST_SETTLE_MS);
    clock.now = PASTE_BURST_SETTLE_MS;
    expect(pipeline.flush()).toEqual([{ type: "paste", text: "first\nsecond\nthird\n" }]);
    expect(pipeline.pendingDeadline).toBeUndefined();
  });

  it("reports the earliest deadline across the decoder and the assembler", () => {
    const { pipeline } = build();
    pipeline.push("a\rb");
    pipeline.push("\x1b");
    expect(pipeline.pendingDeadline).toBe(ESCAPE_TIMEOUT_MS);
  });

  it("does not flush the decoder before its own deadline", () => {
    const { pipeline, clock } = build();
    pipeline.push("a\rb");
    pipeline.push("\x1b");
    clock.now = ESCAPE_TIMEOUT_MS - 1;
    expect(pipeline.flush()).toEqual([]);
    clock.now = ESCAPE_TIMEOUT_MS;
    expect(pipeline.flush()).toEqual([
      { type: "paste", text: "a\nb" },
      { type: "key", key: expect.objectContaining({ name: "escape" }) },
    ]);
  });

  it("keeps typed input prompt: nothing is delayed and Enter stays a key", () => {
    const { pipeline, clock } = build();
    expect(pipeline.push("go")).toHaveLength(2);
    clock.now = 500;
    expect(pipeline.push("\r")).toEqual([
      { type: "key", key: expect.objectContaining({ name: "enter" }) },
    ]);
    expect(pipeline.pendingDeadline).toBeUndefined();
  });
});
