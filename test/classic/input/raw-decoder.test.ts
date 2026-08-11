import { describe, expect, it } from "vitest";
import type { DecodedEvent, KeyEvent } from "../../../src/classic/input/key-event.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";

function decode(input: string, options: { mouse?: boolean } = {}): DecodedEvent[] {
  const decoder = new RawDecoder({ mouse: options.mouse === true });
  return [...decoder.push(input), ...decoder.flush()];
}

function keys(input: string): KeyEvent[] {
  return decode(input).flatMap((event) => (event.type === "key" ? [event.key] : []));
}

function onlyKey(input: string): KeyEvent {
  const all = keys(input);
  expect(all).toHaveLength(1);
  return all[0] as KeyEvent;
}

describe("raw control bytes are claimed before text", () => {
  it("maps 0x0A to ctrl+j", () => {
    expect(onlyKey("\n")).toMatchObject({ name: "j", ctrl: true, text: "" });
  });

  it("maps 0x08 to ctrl+h", () => {
    expect(onlyKey("\x08")).toMatchObject({ name: "h", ctrl: true });
  });

  it("maps 0x7F to backspace", () => {
    expect(onlyKey("\x7f")).toMatchObject({ name: "backspace", ctrl: false });
  });

  it("maps 0x0D to enter and 0x09 to tab", () => {
    expect(onlyKey("\r")).toMatchObject({ name: "enter" });
    expect(onlyKey("\t")).toMatchObject({ name: "tab", text: "\t" });
  });

  it("maps 0x03 to ctrl+c", () => {
    expect(onlyKey("\x03")).toMatchObject({ name: "c", ctrl: true });
  });

  it("maps the remaining C0 letters to ctrl+<letter>", () => {
    expect(onlyKey("\x01")).toMatchObject({ name: "a", ctrl: true });
    expect(onlyKey("\x18")).toMatchObject({ name: "x", ctrl: true });
    expect(onlyKey("\x00")).toMatchObject({ name: "space", ctrl: true });
  });
});

describe("escape disambiguation", () => {
  it("reports a lone escape only after the pending buffer is flushed", () => {
    const decoder = new RawDecoder();
    expect(decoder.push("\x1b")).toEqual([]);
    expect(decoder.pendingDeadline).toBeDefined();
    expect(decoder.flush()).toEqual([{ type: "key", key: expect.objectContaining({ name: "escape" }) }]);
  });

  it("reads escape followed by a printable byte as alt+<byte>", () => {
    expect(onlyKey("\x1bb")).toMatchObject({ name: "b", alt: true, text: "" });
    expect(onlyKey("\x1bB")).toMatchObject({ name: "b", alt: true, shift: true });
  });

  it("reads \\x1b\\r as one alt+enter event", () => {
    expect(onlyKey("\x1b\r")).toMatchObject({ name: "enter", alt: true });
  });

  it("reads a doubled escape before a CSI sequence as alt+<key>", () => {
    expect(onlyKey("\x1b\x1b[A")).toMatchObject({ name: "up", alt: true });
  });

  it("reads a doubled escape alone as one escape per press", () => {
    expect(keys("\x1b\x1b")).toEqual([
      expect.objectContaining({ name: "escape" }),
      expect.objectContaining({ name: "escape" }),
    ]);
  });
});

describe("CSI, SS3, and CSI-u", () => {
  it("decodes arrows, navigation, and function keys", () => {
    expect(onlyKey("\x1b[A")).toMatchObject({ name: "up" });
    expect(onlyKey("\x1b[B")).toMatchObject({ name: "down" });
    expect(onlyKey("\x1b[C")).toMatchObject({ name: "right" });
    expect(onlyKey("\x1b[D")).toMatchObject({ name: "left" });
    expect(onlyKey("\x1b[H")).toMatchObject({ name: "home" });
    expect(onlyKey("\x1b[F")).toMatchObject({ name: "end" });
    expect(onlyKey("\x1b[5~")).toMatchObject({ name: "pageup" });
    expect(onlyKey("\x1b[6~")).toMatchObject({ name: "pagedown" });
    expect(onlyKey("\x1b[3~")).toMatchObject({ name: "delete" });
    expect(onlyKey("\x1b[15~")).toMatchObject({ name: "f5" });
    expect(onlyKey("\x1b[24~")).toMatchObject({ name: "f12" });
    expect(onlyKey("\x1bOP")).toMatchObject({ name: "f1" });
    expect(onlyKey("\x1b[Z")).toMatchObject({ name: "tab", shift: true });
  });

  it("applies the CSI modifier bitmask", () => {
    expect(onlyKey("\x1b[1;5A")).toMatchObject({ name: "up", ctrl: true });
    expect(onlyKey("\x1b[1;2A")).toMatchObject({ name: "up", shift: true });
    expect(onlyKey("\x1b[1;3A")).toMatchObject({ name: "up", alt: true });
    expect(onlyKey("\x1b[1;9A")).toMatchObject({ name: "up", meta: true });
    expect(onlyKey("\x1b[3;5~")).toMatchObject({ name: "delete", ctrl: true });
  });

  it("decodes CSI-u shift+enter, which is the whole reason the decoder exists", () => {
    expect(onlyKey("\x1b[13;2u")).toMatchObject({
      name: "enter",
      shift: true,
      text: "",
    });
  });

  it("decodes CSI-u letters with modifiers and sub-parameters", () => {
    expect(onlyKey("\x1b[99;6u")).toMatchObject({ name: "c", ctrl: true, shift: true });
    expect(onlyKey("\x1b[13;2:1u")).toMatchObject({ name: "enter", shift: true });
    expect(onlyKey("\x1b[97;1u")).toMatchObject({ name: "a", text: "a" });
  });

  it("never leaks a CSI-u sequence as text", () => {
    for (const key of keys("\x1b[13;2u")) expect(key.text).not.toContain("\x1b");
  });
});

describe("unknown sequences are dropped, never turned into text", () => {
  it("drops an unrecognised CSI final byte", () => {
    expect(decode("\x1b[1;2W")).toEqual([]);
  });

  it("drops OSC and DCS strings", () => {
    expect(decode("\x1b]0;a window title\x07")).toEqual([]);
    expect(decode("\x1bP+q544e\x1b\\")).toEqual([]);
    expect(decode("\x1b]52;c;aGk=\x07")).toEqual([]);
  });

  it("drops an incomplete sequence on flush instead of emitting bytes", () => {
    expect(decode("\x1b[1;")).toEqual([]);
    expect(decode("\x1bO")).toEqual([]);
  });

  it("keeps decoding after a dropped sequence", () => {
    expect(keys("\x1b[1;2Wab")).toEqual([
      expect.objectContaining({ text: "a" }),
      expect.objectContaining({ text: "b" }),
    ]);
  });
});

describe("text and graphemes", () => {
  it("emits one event per grapheme, never splitting a code point", () => {
    expect(keys("añ漢")).toEqual([
      expect.objectContaining({ name: "a", text: "a" }),
      expect.objectContaining({ text: "ñ" }),
      expect.objectContaining({ text: "漢" }),
    ]);
  });

  it("keeps a combining sequence in one event", () => {
    const decoded = keys("e\u0301");
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.text).toBe("e\u0301");
  });

  it("keeps an emoji with a variation selector in one event", () => {
    const decoded = keys("👍🏽");
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.text).toBe("👍🏽");
  });

  it("reports shift for a capital letter", () => {
    expect(onlyKey("A")).toMatchObject({ name: "a", shift: true, text: "A" });
  });
});

describe("chunk safety", () => {
  const inputs = [
    "\x1b[13;2u",
    "\x1b[<0;10;5M",
    "\x1b[200~hello\x1b[201~",
    "\x1b[1;5A\x1b[6~ab",
    "\x1b]0;title\x07x",
  ];

  it("decodes identically for every split point", () => {
    for (const input of inputs) {
      const whole = decode(input, { mouse: true });
      for (let at = 1; at < input.length; at += 1) {
        const decoder = new RawDecoder({ mouse: true });
        const events = [
          ...decoder.push(input.slice(0, at)),
          ...decoder.push(input.slice(at)),
          ...decoder.flush(),
        ];
        expect(events).toEqual(whole);
      }
    }
  });

  it("decodes identically byte by byte", () => {
    for (const input of inputs) {
      const decoder = new RawDecoder({ mouse: true });
      const events: DecodedEvent[] = [];
      for (const char of input) events.push(...decoder.push(char));
      events.push(...decoder.flush());
      expect(events).toEqual(decode(input, { mouse: true }));
    }
  });
});
