import { describe, expect, it } from "vitest";
import type { DecodedEvent } from "../../../src/classic/input/key-event.js";
import { sanitizePasteText } from "../../../src/classic/input/paste-decoder.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import {
  PASTE_END,
  PASTE_START,
  PASTE_TIMEOUT_MS,
} from "../../../src/classic/input/terminal-sequences.js";

function bracket(body: string): string {
  return `${PASTE_START}${body}${PASTE_END}`;
}

function decode(input: string): DecodedEvent[] {
  const decoder = new RawDecoder();
  return [...decoder.push(input), ...decoder.flush()];
}

describe("bracketed paste", () => {
  it("produces exactly one paste event and no key events", () => {
    expect(decode(bracket("hello world"))).toEqual([
      { type: "paste", text: "hello world" },
    ]);
  });

  it("normalises CR and CRLF to LF and keeps tabs", () => {
    expect(decode(bracket("a\r\nb\rc\td"))).toEqual([
      { type: "paste", text: "a\nb\nc\td" },
    ]);
  });

  it("strips other C0 controls and ANSI sequences", () => {
    const text = "keep\x1b[31mred\x1b[0m\x07\x00 end";
    expect(decode(bracket(text))).toEqual([{ type: "paste", text: "keepred end" }]);
  });

  it("never turns pasted control bytes into key events", () => {
    const events = decode(bracket("\x03\x1b\x0dgo"));
    expect(events.every((event) => event.type === "paste")).toBe(true);
  });

  it("survives a paste split across chunks, including inside the terminator", () => {
    const decoder = new RawDecoder();
    const events: DecodedEvent[] = [];
    events.push(...decoder.push(`${PASTE_START}first `));
    events.push(...decoder.push("second\x1b["));
    events.push(...decoder.push("201~"));
    expect(events).toEqual([{ type: "paste", text: "first second" }]);
  });

  it("keeps a 500-line paste as one event", () => {
    const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const events = decode(bracket(body));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "paste", text: body });
  });

  it("decodes keys typed after the paste normally", () => {
    const events = decode(`${bracket("x")}\r`);
    expect(events).toEqual([
      { type: "paste", text: "x" },
      { type: "key", key: expect.objectContaining({ name: "enter" }) },
    ]);
  });

  it("flushes an unterminated paste after the idle timeout with a warning", () => {
    let now = 1000;
    const warnings: string[] = [];
    const decoder = new RawDecoder({
      now: () => now,
      onWarn: (message) => warnings.push(message),
    });
    expect(decoder.push(`${PASTE_START}partial`)).toEqual([]);
    now += PASTE_TIMEOUT_MS + 1;
    expect(decoder.push("more")).toEqual([
      { type: "paste", text: "partialmore" },
    ]);
    expect(warnings).toEqual(["paste ended without a terminator"]);
  });

  it("flushes an unterminated paste when the stream ends", () => {
    const decoder = new RawDecoder();
    expect(decoder.push(`${PASTE_START}tail`)).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: "paste", text: "tail" }]);
  });

  it("ignores a stray paste terminator", () => {
    expect(decode(PASTE_END)).toEqual([]);
  });
});

describe("sanitizePasteText", () => {
  it("is idempotent", () => {
    const raw = "a\r\n\x1b[1mb\x1b[0m\x00c";
    expect(sanitizePasteText(sanitizePasteText(raw))).toBe(sanitizePasteText(raw));
  });

  it("never leaves an escape byte behind", () => {
    expect(sanitizePasteText("\x1b[38;5;208mx\x1b]8;;http://a\x07link")).not.toContain(
      "\x1b",
    );
  });
});
