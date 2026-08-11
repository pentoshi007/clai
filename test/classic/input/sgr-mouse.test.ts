import { describe, expect, it } from "vitest";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";
import { parseSgrMouse } from "../../../src/classic/input/sgr-mouse.js";

describe("parseSgrMouse", () => {
  it("decodes a left press with zero-based coordinates", () => {
    expect(parseSgrMouse("0;10;5", "M")).toEqual({
      button: "left",
      x: 9,
      y: 4,
      release: false,
      drag: false,
      scroll: undefined,
      ctrl: false,
      alt: false,
      shift: false,
    });
  });

  it("decodes middle and right buttons", () => {
    expect(parseSgrMouse("1;1;1", "M")?.button).toBe("middle");
    expect(parseSgrMouse("2;1;1", "M")?.button).toBe("right");
  });

  it("decodes release with the lowercase final byte", () => {
    expect(parseSgrMouse("0;3;3", "m")?.release).toBe(true);
  });

  it("decodes drag", () => {
    const event = parseSgrMouse("32;4;4", "M");
    expect(event?.drag).toBe(true);
    expect(event?.button).toBe("left");
  });

  it("decodes wheel up and down", () => {
    expect(parseSgrMouse("64;1;1", "M")?.scroll).toBe("up");
    expect(parseSgrMouse("65;1;1", "M")?.scroll).toBe("down");
    expect(parseSgrMouse("64;1;1", "M")?.drag).toBe(false);
  });

  it("decodes modifiers", () => {
    const event = parseSgrMouse("28;1;1", "M");
    expect(event).toMatchObject({ shift: true, alt: true, ctrl: true });
  });

  it("rejects malformed reports", () => {
    expect(parseSgrMouse("0;1", "M")).toBeUndefined();
    expect(parseSgrMouse("0;0;1", "M")).toBeUndefined();
    expect(parseSgrMouse("x;1;1", "M")).toBeUndefined();
    expect(parseSgrMouse("0;1;1", "A")).toBeUndefined();
  });
});

describe("mouse reports in the byte stream", () => {
  it("emits a mouse event when mouse reporting is on", () => {
    const decoder = new RawDecoder({ mouse: true });
    expect(decoder.push("\x1b[<0;10;5M")).toEqual([
      { type: "mouse", event: expect.objectContaining({ x: 9, y: 4 }) },
    ]);
  });

  it("consumes and discards the report when mouse reporting is off", () => {
    const decoder = new RawDecoder({ mouse: false });
    expect(decoder.push("\x1b[<0;10;5M")).toEqual([]);
    expect(decoder.pending).toBe(false);
  });

  it("never leaks a report into text", () => {
    const decoder = new RawDecoder({ mouse: false });
    const events = [...decoder.push("\x1b[<0;10;5Mab"), ...decoder.flush()];
    expect(events).toEqual([
      { type: "key", key: expect.objectContaining({ text: "a" }) },
      { type: "key", key: expect.objectContaining({ text: "b" }) },
    ]);
  });
});
