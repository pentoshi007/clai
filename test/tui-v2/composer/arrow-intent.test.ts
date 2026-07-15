import { describe, expect, it } from "vitest";
import {
  ARROW_BURST_THRESHOLD,
  resolveArrowIntent,
} from "../../../src/tui-v2/composer/arrow-intent.js";

const base = {
  plainText: "",
  line: 0,
  lineCount: 1,
  menuOpen: false,
  isBrowsingHistory: false,
  burstCount: 0,
};

describe("resolveArrowIntent", () => {
  it("recalls history on empty idle ↑/↓ (classic CLAI)", () => {
    expect(resolveArrowIntent({ ...base, chord: "up" })).toBe("history");
    expect(resolveArrowIntent({ ...base, chord: "down" })).toBe("history");
  });

  it("recalls history when the buffer has text at the line boundary", () => {
    expect(
      resolveArrowIntent({
        ...base,
        chord: "up",
        plainText: "who is uk pm",
        line: 0,
        lineCount: 1,
      }),
    ).toBe("history");
  });

  it("treats rapid arrow bursts as chat scroll (trackpad emulation)", () => {
    expect(
      resolveArrowIntent({
        ...base,
        chord: "up",
        plainText: "typed something",
        burstCount: ARROW_BURST_THRESHOLD,
      }),
    ).toBe("scroll-chat");
  });

  it("does not steal mid-buffer multi-line cursor moves", () => {
    expect(
      resolveArrowIntent({
        ...base,
        chord: "up",
        plainText: "a\nb\nc",
        line: 1,
        lineCount: 3,
      }),
    ).toBe("ignore");
  });

  it("ignores arrows while the completion menu is open", () => {
    expect(resolveArrowIntent({ ...base, chord: "up", menuOpen: true })).toBe("ignore");
  });
});
