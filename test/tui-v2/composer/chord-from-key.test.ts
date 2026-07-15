import { describe, expect, it } from "vitest";
import { chordFromKeyEvent } from "../../../src/tui-v2/actions/chord-from-key.js";

describe("chordFromKeyEvent", () => {
  it("maps a plain letter key", () => {
    expect(chordFromKeyEvent({ name: "c" })).toBe("c");
  });

  it("maps ctrl+letter", () => {
    expect(chordFromKeyEvent({ name: "c", ctrl: true })).toBe("ctrl+c");
  });

  it("maps plain enter/kpenter to the enter chord", () => {
    expect(chordFromKeyEvent({ name: "return" })).toBe("enter");
    expect(chordFromKeyEvent({ name: "kpenter" })).toBe("enter");
  });

  it("maps shift+return to shift+enter", () => {
    expect(chordFromKeyEvent({ name: "return", shift: true })).toBe(
      "shift+enter",
    );
  });

  it("maps meta/option+return to alt+enter", () => {
    expect(chordFromKeyEvent({ name: "return", meta: true })).toBe(
      "alt+enter",
    );
    expect(chordFromKeyEvent({ name: "return", option: true })).toBe(
      "alt+enter",
    );
  });

  it("normalizes bare linefeed (raw Ctrl+J byte) to ctrl+j", () => {
    expect(chordFromKeyEvent({ name: "linefeed" })).toBe("ctrl+j");
  });

  it("maps super to the meta chord modifier", () => {
    expect(chordFromKeyEvent({ name: "a", super: true })).toBe("meta+a");
  });

  it("orders and dedupes multiple modifiers", () => {
    expect(
      chordFromKeyEvent({ name: "a", ctrl: true, meta: true, shift: true }),
    ).toBe("ctrl+alt+shift+a");
  });
});
