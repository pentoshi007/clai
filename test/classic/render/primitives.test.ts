import { describe, expect, it } from "vitest";
import {
  alignEnds,
  clipToWidth,
  hasOpenStyle,
  padToWidth,
  sealStyle,
  tokenize,
} from "../../../src/classic/render/ansi-text.js";
import { displayWidth, layoutWidth } from "../../../src/classic/render/measure.js";
import { reflowRows, wrapAnsiLine, wrapWithPrefixes } from "../../../src/classic/render/wrap.js";
import { createInkTheme } from "../../../src/classic/render/ink-theme.js";
import { toAsciiGlyphs, UNICODE_GLYPHS } from "../../../src/classic/render/glyphs.js";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

describe("tokenize", () => {
  it("separates escapes from printable runs", () => {
    expect(tokenize(`${RED}ab${RESET}`)).toEqual([
      { kind: "escape", value: RED },
      { kind: "text", value: "ab" },
      { kind: "escape", value: RESET },
    ]);
  });

  it("returns a single run when there is no escape", () => {
    expect(tokenize("plain")).toEqual([{ kind: "text", value: "plain" }]);
  });
});

describe("sealStyle", () => {
  it("appends a reset only when a style is left open", () => {
    expect(hasOpenStyle(`${RED}x`)).toBe(true);
    expect(sealStyle(`${RED}x`)).toBe(`${RED}x${RESET}`);
    expect(sealStyle(`${RED}x${RESET}`)).toBe(`${RED}x${RESET}`);
    expect(sealStyle("x")).toBe("x");
  });
});

describe("clipToWidth", () => {
  it("keeps content that already fits", () => {
    expect(clipToWidth("abc", 5)).toBe("abc");
  });

  it("clips to the budget including the suffix", () => {
    expect(clipToWidth("abcdefgh", 5, "…")).toBe("abcd…");
    expect(displayWidth(clipToWidth("abcdefgh", 5, "…"))).toBe(5);
  });

  it("never splits a double-width grapheme across the edge", () => {
    const clipped = clipToWidth("日本語です", 5, "…");
    expect(displayWidth(clipped)).toBeLessThanOrEqual(5);
  });

  it("preserves escapes and seals the result", () => {
    const clipped = clipToWidth(`${RED}abcdef`, 3);
    expect(clipped.startsWith(RED)).toBe(true);
    expect(clipped.endsWith(RESET)).toBe(true);
    expect(displayWidth(clipped)).toBe(3);
  });

  it("returns empty at a non-positive budget", () => {
    expect(clipToWidth("abc", 0)).toBe("");
  });
});

describe("alignEnds", () => {
  it("flushes the right side to the width", () => {
    const row = alignEnds("left", "7s", 20, "…");
    expect(displayWidth(row)).toBe(20);
    expect(row.endsWith("7s")).toBe(true);
  });

  it("drops the right side when it cannot fit", () => {
    const row = alignEnds("left", "running · 7s", 8, "…");
    expect(row).toBe("left");
  });
});

describe("padToWidth", () => {
  it("pads by layout width, not string length", () => {
    expect(displayWidth(padToWidth(`${RED}ab${RESET}`, 5))).toBe(5);
  });
});

describe("wrapAnsiLine", () => {
  it("breaks at spaces", () => {
    expect(wrapAnsiLine("alpha beta gamma", 11)).toEqual(["alpha beta", "gamma"]);
  });

  it("hard-breaks a token wider than the budget", () => {
    expect(wrapAnsiLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("never emits a row wider than the budget", () => {
    const text = "The quick brown 日本語 fox jumped over aaaaaaaaaaaaaaaaaaaaaa lazy dogs";
    for (const budget of [4, 7, 12, 20, 33, 80]) {
      for (const row of wrapAnsiLine(text, budget)) {
        expect(layoutWidth(row)).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("re-opens the active style on continuation rows", () => {
    const rows = wrapAnsiLine(`${RED}alpha beta gamma${RESET}`, 6);
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      expect(row.startsWith(RED)).toBe(true);
      expect(row.endsWith(RESET)).toBe(true);
    }
  });

  it("returns one empty row for empty input", () => {
    expect(wrapAnsiLine("", 10)).toEqual([""]);
  });
});

describe("wrapWithPrefixes", () => {
  it("applies distinct first and continuation prefixes", () => {
    expect(wrapWithPrefixes("alpha beta gamma", { width: 12, firstPrefix: "◆ ", nextPrefix: "  " })).toEqual([
      "◆ alpha beta",
      "  gamma",
    ]);
  });

  it("respects embedded newlines", () => {
    expect(wrapWithPrefixes("a\nb", { width: 10 })).toEqual(["a", "b"]);
  });
});

describe("reflowRows", () => {
  it("leaves fitting rows untouched and splits the rest", () => {
    expect(reflowRows(["ok", "abcdefgh"], 4)).toEqual(["ok", "abcd", "efgh"]);
  });
});

describe("createInkTheme", () => {
  it("emits no escapes at colorMode none", () => {
    const t = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: true });
    expect(t.fg("cyan", "text")).toBe("text");
    expect(t.inkColor("cyan")).toBeUndefined();
  });

  it("emits truecolor escapes at truecolor", () => {
    const t = createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true });
    expect(t.fg("cyan", "text")).toContain("\x1b[38;2;");
    expect(t.inkColor("cyan")).toBe(t.theme.cyan);
  });

  it("degrades to a basic name at 16 colours", () => {
    const t = createInkTheme({ themeHint: "dark", colorMode: "16", unicode: true });
    const painted = t.fg("cyan", "text");
    expect(painted).not.toContain("38;2;");
    expect(painted).toContain("\x1b[");
    expect(displayWidth(painted)).toBe(4);
  });

  it("selects the ASCII glyph table when unicode is off", () => {
    const t = createInkTheme({ themeHint: "dark", colorMode: "none", unicode: false });
    expect(t.glyphs.assistantBullet).toBe("*");
  });
});

describe("toAsciiGlyphs", () => {
  it("downgrades presenter glyphs", () => {
    expect(toAsciiGlyphs(`${UNICODE_GLYPHS.toolOk} done`)).toBe("v done");
    expect(toAsciiGlyphs("unchanged")).toBe("unchanged");
  });
});
