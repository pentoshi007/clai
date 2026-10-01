import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DecodedEvent } from "../../../src/classic/input/key-event.js";
import { PasteBurstAssembler } from "../../../src/classic/input/paste-burst.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import {
  PASTE_BURST_GLUE_MS,
  PASTE_BURST_SETTLE_MS,
} from "../../../src/classic/input/terminal-sequences.js";

function decode(bytes: string): DecodedEvent[] {
  const decoder = new RawDecoder();
  return [...decoder.push(bytes), ...decoder.flush()];
}

function describeEvents(events: readonly DecodedEvent[]): string[] {
  return events.map((event) => {
    if (event.type === "paste") return `paste:${JSON.stringify(event.text)}`;
    if (event.type === "mouse") return "mouse";
    return event.key.text.length > 0 ? `key:${event.key.text}` : `key:${event.key.name}`;
  });
}

describe("PasteBurstAssembler", () => {
  it("passes typed input through untouched and immediately", () => {
    const assembler = new PasteBurstAssembler();
    expect(describeEvents(assembler.process(decode("a"), 0))).toEqual(["key:a"]);
    expect(describeEvents(assembler.process(decode("b"), 100))).toEqual(["key:b"]);
    expect(describeEvents(assembler.process(decode("\r"), 300))).toEqual(["key:enter"]);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("turns a multi-line chunk into one paste once input settles", () => {
    const assembler = new PasteBurstAssembler();
    expect(assembler.process(decode("one\rtwo\rthree"), 0)).toEqual([]);
    expect(assembler.pendingDeadline).toBe(PASTE_BURST_SETTLE_MS);
    expect(assembler.expire(PASTE_BURST_SETTLE_MS - 1)).toEqual([]);
    expect(assembler.expire(PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "one\ntwo\nthree" },
    ]);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("keeps one paste together while chunks keep arriving inside the window", () => {
    const assembler = new PasteBurstAssembler();
    const gap = PASTE_BURST_SETTLE_MS - 50;
    expect(assembler.process(decode("one\rtw"), 0)).toEqual([]);
    expect(assembler.process(decode("o\rthr"), gap)).toEqual([]);
    expect(assembler.process(decode("ee"), gap * 2)).toEqual([]);
    expect(assembler.expire(gap * 2 + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "one\ntwo\nthree" },
    ]);
  });

  it("starts a new paste after a gap longer than the window", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("one\rtwo"), 0);
    const later = PASTE_BURST_SETTLE_MS + 1;
    expect(describeEvents(assembler.process(decode("x\ry"), later))).toEqual([
      'paste:"one\\ntwo"',
    ]);
    expect(assembler.expire(later + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "x\ny" },
    ]);
  });

  it("treats an Enter glued to the text before it as part of the paste", () => {
    const assembler = new PasteBurstAssembler();
    expect(describeEvents(assembler.process(decode("line1"), 0))).toHaveLength(5);
    expect(assembler.process(decode("\r"), PASTE_BURST_GLUE_MS)).toEqual([]);
    expect(assembler.process(decode("line2"), PASTE_BURST_GLUE_MS + 5)).toEqual([]);
    expect(assembler.expire(PASTE_BURST_GLUE_MS + 5 + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "\nline2" },
    ]);
  });

  it("submits an Enter that is not glued to the keystrokes before it", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("a"), 0);
    assembler.process(decode("b"), 100);
    expect(describeEvents(assembler.process(decode("\r"), 100 + PASTE_BURST_GLUE_MS + 1))).toEqual([
      "key:enter",
    ]);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("waits one settle window before submitting an Enter that follows a multi-character read", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("abc"), 0);
    const arrival = PASTE_BURST_GLUE_MS + 1;
    expect(assembler.process(decode("\r"), arrival)).toEqual([]);
    expect(assembler.pendingDeadline).toBe(arrival + PASTE_BURST_SETTLE_MS);
    expect(describeEvents(assembler.expire(arrival + PASTE_BURST_SETTLE_MS))).toEqual(["key:enter"]);
  });

  it("keeps a paste whole when its lines arrive as separate reads with blank lines between", () => {
    const assembler = new PasteBurstAssembler();
    const gap = PASTE_BURST_SETTLE_MS - 10;
    const emitted: DecodedEvent[] = [];
    ["first line\r", "\r", "third line\r", "fourth"].forEach((piece, index) => {
      emitted.push(...assembler.process(decode(piece), index * gap));
    });
    emitted.push(...assembler.expire(Number.MAX_SAFE_INTEGER));
    expect(describeEvents(emitted)).toEqual(['paste:"first line\\n\\nthird line\\nfourth"']);
  });

  it("holds a trailing Enter after text and releases it as keys when nothing follows", () => {
    const assembler = new PasteBurstAssembler();
    expect(assembler.process(decode("hello\r"), 0)).toEqual([]);
    expect(assembler.pendingDeadline).toBe(PASTE_BURST_SETTLE_MS);
    expect(assembler.expire(PASTE_BURST_SETTLE_MS - 1)).toEqual([]);
    expect(describeEvents(assembler.expire(PASTE_BURST_SETTLE_MS))).toEqual([
      "key:h",
      "key:e",
      "key:l",
      "key:l",
      "key:o",
      "key:enter",
    ]);
  });

  it("turns a held trailing Enter into a newline when more input follows", () => {
    const assembler = new PasteBurstAssembler();
    expect(assembler.process(decode("hello\r"), 0)).toEqual([]);
    expect(assembler.process(decode("world"), PASTE_BURST_GLUE_MS - 5)).toEqual([]);
    expect(assembler.expire(PASTE_BURST_GLUE_MS + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "hello\nworld" },
    ]);
  });

  it("releases a held line as typed input when a non-text event follows", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("hi\r"), 0);
    expect(describeEvents(assembler.process(decode("\x1b[A"), 5))).toEqual([
      "key:h",
      "key:i",
      "key:enter",
      "key:up",
    ]);
  });

  it("flushes the collected paste before a non-text event and keeps their order", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("a\rb"), 0);
    expect(describeEvents(assembler.process(decode("\x1b[A"), 50))).toEqual([
      'paste:"a\\nb"',
      "key:up",
    ]);
  });

  it("never folds modified keys into a paste", () => {
    const assembler = new PasteBurstAssembler();
    const events = decode("a\r\x03");
    expect(assembler.process(events, 0)).toEqual(events);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("collapses CRLF and accepts bare LF as a newline inside a paste", () => {
    const crlf = new PasteBurstAssembler();
    crlf.process(decode("a\r\nb"), 0);
    expect(crlf.expire(PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "a\nb" }]);
    const lf = new PasteBurstAssembler();
    lf.process(decode("a\nb\nc"), 0);
    expect(lf.expire(PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "a\nb\nc" }]);
  });

  it("leaves an isolated Ctrl+J untouched so its binding keeps working", () => {
    const assembler = new PasteBurstAssembler();
    const events = decode("\n");
    expect(assembler.process(events, 0)).toEqual(events);
  });

  it("keeps tabs as text inside a paste", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("if x:\r\tpass"), 0);
    expect(assembler.expire(PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "if x:\n\tpass" },
    ]);
  });

  it("does not touch a bracketed paste", () => {
    const assembler = new PasteBurstAssembler();
    const events = decode("\x1b[200~a\nb\x1b[201~");
    expect(assembler.process(events, 0)).toEqual(events);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("never drops or reorders content whatever the chunking and timing", () => {
    const chunk = fc.stringMatching(/^[a-z \r\t]{1,8}$/);
    const step = fc.record({ bytes: chunk, gap: fc.integer({ min: 0, max: 400 }) });
    const contentOf = (events: readonly DecodedEvent[]): string =>
      events
        .map((event) => {
          if (event.type === "paste") return event.text;
          if (event.type === "key") return event.key.name === "enter" ? "\n" : event.key.text;
          return "";
        })
        .join("");
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 12 }), (steps) => {
        const assembler = new PasteBurstAssembler();
        const emitted: DecodedEvent[] = [];
        const sent: DecodedEvent[] = [];
        let now = 0;
        for (const { bytes, gap } of steps) {
          now += gap;
          emitted.push(...assembler.expire(now));
          const events = decode(bytes);
          sent.push(...events);
          emitted.push(...assembler.process(events, now));
        }
        emitted.push(...assembler.expire(Number.MAX_SAFE_INTEGER));
        expect(contentOf(emitted)).toBe(contentOf(sent));
        expect(assembler.pendingDeadline).toBeUndefined();
      }),
      { numRuns: 2_000 },
    );
  });
});
  it("leaves an Enter followed by text in one read alone once the read before it is long past", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("/help"), 0);
    const events = decode("\rqresize smoke");
    expect(assembler.process(events, PASTE_BURST_SETTLE_MS + 1)).toEqual(events);
    expect(assembler.pendingDeadline).toBeUndefined();
  });

  it("joins an Enter followed by text to a multi-character read that arrived within the settle window", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("/help"), 0);
    expect(assembler.process(decode("\rqresize smoke"), PASTE_BURST_SETTLE_MS)).toEqual([]);
    expect(assembler.expire(PASTE_BURST_SETTLE_MS * 2)).toEqual([
      { type: "paste", text: "\nqresize smoke" },
    ]);
  });

  it("still joins a leading Enter to a paste whose previous piece just arrived", () => {
    const assembler = new PasteBurstAssembler();
    assembler.process(decode("line1"), 0);
    expect(assembler.process(decode("\rline2"), PASTE_BURST_GLUE_MS)).toEqual([]);
    expect(assembler.expire(PASTE_BURST_GLUE_MS + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "\nline2" },
    ]);
  });

