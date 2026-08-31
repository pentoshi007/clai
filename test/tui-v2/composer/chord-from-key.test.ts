import { describe, expect, it } from "vitest";
import {
  chordFromKeyEvent,
  consumeCancellationKeyRepeat,
  isKeyEventRelease,
  isKeyEventRepeat,
} from "../../../src/tui-v2/input/chord-from-opentui-key.js";
import {
  escapeCancellationAction,
  preserveEscapeArmAfterTurn,
} from "../../../src/tui-v2/input/escape-cancellation.js";

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

  it("maps Shift+Tab to shift+tab whether reported as tab+shift or backtab", () => {
    expect(chordFromKeyEvent({ name: "tab", shift: true })).toBe("shift+tab");
    expect(chordFromKeyEvent({ name: "backtab" })).toBe("shift+tab");
  });

  it("maps uppercase character names to shift chords", () => {
    expect(chordFromKeyEvent({ name: "X", ctrl: true })).toBe("ctrl+shift+x");
    expect(chordFromKeyEvent({ name: "X" })).toBe("shift+x");
  });
});

describe("escape and event normalization", () => {
  it("normalizes escape names and exact raw escape bytes", () => {
    expect(chordFromKeyEvent({ name: "escape" })).toBe("escape");
    expect(chordFromKeyEvent({ name: "esc" })).toBe("escape");
    expect(chordFromKeyEvent({ name: "\x1b" })).toBe("escape");
    expect(chordFromKeyEvent({ name: "unknown", sequence: "\x1b" })).toBe(
      "escape",
    );
    expect(chordFromKeyEvent({ name: "unknown", raw: "\x1b" })).toBe(
      "escape",
    );
  });

  it("does not mistake Alt or CSI sequences for Escape", () => {
    expect(
      chordFromKeyEvent({ name: "x", meta: true, sequence: "\x1bx" }),
    ).toBe("alt+x");
    expect(
      chordFromKeyEvent({ name: "up", sequence: "\x1b[A", raw: "\x1b[A" }),
    ).toBe("up");
  });

  it("recognizes raw and Kitty release and repeat shapes", () => {
    expect(
      isKeyEventRelease({
        name: "escape",
        source: "kitty",
        eventType: "release",
      }),
    ).toBe(true);
    expect(
      isKeyEventRepeat({
        name: "escape",
        source: "raw",
        eventType: "repeat",
      }),
    ).toBe(true);
    expect(
      isKeyEventRepeat({
        name: "escape",
        source: "kitty",
        eventType: "press",
        repeated: true,
      }),
    ).toBe(true);
    expect(
      isKeyEventRepeat({ name: "escape", eventType: "press" }),
    ).toBe(false);
  });
});

describe("cancellation key repeats", () => {
  it("consumes held cancellation keys and stops propagation", () => {
    let prevented = 0;
    let stopped = 0;
    const consumed = consumeCancellationKeyRepeat(
      {
        name: "escape",
        repeated: true,
        preventDefault: () => {
          prevented += 1;
        },
        stopPropagation: () => {
          stopped += 1;
        },
      },
      "escape",
    );

    expect(consumed).toBe(true);
    expect(prevented).toBe(1);
    expect(stopped).toBe(1);
  });

  it("leaves first presses and unrelated repeats untouched", () => {
    let prevented = 0;
    const key = {
      name: "escape",
      eventType: "press" as const,
      preventDefault: () => {
        prevented += 1;
      },
    };

    expect(consumeCancellationKeyRepeat(key, "escape")).toBe(false);
    expect(
      consumeCancellationKeyRepeat(
        { ...key, eventType: "repeat" as const },
        "a",
      ),
    ).toBe(false);
    expect(prevented).toBe(0);
  });
});

describe("escape cancellation decisions", () => {
  it("gives dismissal precedence over cancellation", () => {
    expect(
      escapeCancellationAction({
        dismissed: true,
        doublePress: true,
        hasCancelableWork: true,
      }),
    ).toBe("dismiss");
  });

  it("uses cancel-all only for an armed second press with remaining work", () => {
    expect(
      escapeCancellationAction({
        dismissed: false,
        doublePress: true,
        hasCancelableWork: true,
      }),
    ).toBe("cancel-all");
    expect(
      escapeCancellationAction({
        dismissed: false,
        doublePress: false,
        hasCancelableWork: true,
      }),
    ).toBe("abort-foreground");
    expect(
      escapeCancellationAction({
        dismissed: false,
        doublePress: true,
        hasCancelableWork: false,
      }),
    ).toBe("abort-foreground");
  });

  it("preserves the arm only while cancelable work remains", () => {
    expect(preserveEscapeArmAfterTurn(true)).toBe(true);
    expect(preserveEscapeArmAfterTurn(false)).toBe(false);
  });
});