import { describe, expect, it } from "vitest";
import {
  panelBodyHeight,
  panelBodyWidth,
  panelFrameRows,
} from "../../../src/classic/panels/panel-frame.js";
import { displayWidth, stripAnsi } from "../../../src/classic/render/measure.js";
import {
  pagerKey,
  pagerLines,
  pagerView,
  resolvePagerMarkdownMode,
  PAGER_INITIAL_STATE,
  type PagerPanelState,
} from "../../../src/classic/panels/pager-panel.js";
import { colorInk, createHarness, ink, rowsOf } from "./harness.js";

const BODY = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");

function render(state: PagerPanelState, rows = 8, columns = 80, live = false) {
  const lines = pagerLines(BODY, columns, rows, state.format);
  const frame = pagerView({ ink, columns, rows, title: "shell.exec · npm test", lines, state, live });
  return { frame, lines, rows: rowsOf(panelFrameRows(frame).rows) };
}

function press(state: PagerPanelState, chord: string, text?: string, rows = 8) {
  return pagerKey({
    state,
    chord,
    text,
    lines: pagerLines(BODY, 80, rows, state.format),
    rows,
    live: false,
    body: BODY,
  });
}

describe("pager rows", () => {
  it("numbers lines only when the body overflows the body height", () => {
    expect(render(PAGER_INITIAL_STATE).rows[1]).toMatch(/^│\s+1▎ line 1/);
    const short = pagerView({
      ink,
      columns: 80,
      rows: 20,
      title: "t",
      lines: pagerLines("a\nb", 80, 20, PAGER_INITIAL_STATE.format),
      state: PAGER_INITIAL_STATE,
    });
    expect(rowsOf(panelFrameRows(short).rows)[1]).toContain("▎ a");
    expect(rowsOf(panelFrameRows(short).rows)[1]).not.toMatch(/\s1▎/);
  });

  it("marks the caret row and counts position over total", () => {
    const { frame, rows } = render({ ...PAGER_INITIAL_STATE, caret: 2, top: 0 });
    expect(frame.counter).toBe("3/12");
    expect(rows[3]).toContain("▎ line 3");
    expect(rows[1]).not.toContain("▎");
  });

  it("carries the format tag and the follow tag", () => {
    expect(render(PAGER_INITIAL_STATE).frame.tags).toEqual(["md"]);
    expect(render({ ...PAGER_INITIAL_STATE, format: "raw" }).frame.tags).toEqual(["raw"]);
    expect(
      render({ ...PAGER_INITIAL_STATE, follow: true }, 8, 80, true).frame.tags,
    ).toEqual(["md", "follow"]);
  });

  it("offers the follow hint only for live sources", () => {
    expect(render(PAGER_INITIAL_STATE).frame.hints).not.toContain("l follow");
    expect(render(PAGER_INITIAL_STATE, 8, 80, true).frame.hints).toContain("l follow");
  });

  it("starts with the requested or detected markdown mode", () => {
    const markdown = "# Heading\n\n**bold** text";
    expect(PAGER_INITIAL_STATE.format).toBe("formatted");
    expect(resolvePagerMarkdownMode(markdown, "force")).toBe("force");
    expect(resolvePagerMarkdownMode(markdown, "plain")).toBe("plain");
    expect(resolvePagerMarkdownMode(markdown, "auto")).toBe("force");
    expect(resolvePagerMarkdownMode("plain tool output", "auto")).toBe("plain");
  });

  it("renders formatted markdown separately from raw source", () => {
    const body = "# Heading\n\n**bold** text";
    const formatted = pagerLines(body, 48, 8, "formatted").map(stripAnsi).join("\n");
    const raw = pagerLines(body, 48, 8, "raw").join("\n");
    expect(formatted).toContain("Heading");
    expect(formatted).not.toContain("# Heading");
    expect(formatted).not.toContain("**bold**");
    expect(raw).toContain("# Heading");
    expect(raw).toContain("**bold** text");
  });
});

describe("pager source normalization and width", () => {
  it("cleans fs.read and diff gutters only in formatted mode", () => {
    const fsRead = [
      "# fs.read path=/tmp/notes.md lines=1-3 of 3",
      "1: # Notes",
      "2: ",
      "3: **bold** text",
      "# hasMore=false",
    ].join("\n");
    const formattedFsRead = pagerLines(fsRead, 80, 8, "formatted").map(stripAnsi).join("\n");
    expect(formattedFsRead).toContain("Notes");
    expect(formattedFsRead).toContain("bold text");
    expect(formattedFsRead).not.toContain("fs.read path");
    expect(formattedFsRead).not.toContain("1: # Notes");

    const diff = ["  1 │ # Notes", "  2 │ ", "  3 │ **bold** text"].join("\n");
    const formattedDiff = pagerLines(diff, 80, 8, "formatted").map(stripAnsi).join("\n");
    const rawDiff = pagerLines(diff, 80, 8, "raw").map(stripAnsi).join("\n");
    expect(formattedDiff).toContain("Notes");
    expect(formattedDiff).not.toContain("│ # Notes");
    expect(rawDiff).toContain("│ # Notes");
  });

  it("accounts for the final number-gutter width after wrapping", () => {
    const columns = 32;
    const rows = 4;
    const lines = pagerLines("word ".repeat(200), columns, rows, "raw");
    const gutter = lines.length > panelBodyHeight(rows) ? String(lines.length).length + 1 : 0;
    const textWidth = panelBodyWidth(columns) - gutter - 2;
    expect(lines.length).toBeGreaterThan(panelBodyHeight(rows));
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(textWidth);

    const frame = pagerView({
      ink,
      columns,
      rows,
      title: "t",
      lines,
      state: PAGER_INITIAL_STATE,
    });
    for (const row of panelFrameRows(frame).rows) {
      expect(displayWidth(row)).toBeLessThanOrEqual(columns);
    }
  });

  it("searches ANSI-bearing raw lines after stripping paint codes", () => {
    const body = "\x1b[31mneedle\x1b[0m other";
    const lines = pagerLines(body, 80, 8, "raw");
    let state = pagerKey({
      state: PAGER_INITIAL_STATE,
      chord: "ctrl+r",
      lines,
      rows: 8,
      live: false,
      body,
    }).state;
    for (const char of "needle") {
      state = pagerKey({
        state,
        chord: char,
        text: char,
        lines,
        rows: 8,
        live: false,
        body,
      }).state;
    }
    state = pagerKey({
      state,
      chord: "enter",
      lines,
      rows: 8,
      live: false,
      body,
    }).state;
    expect(state.query).toBe("needle");
    expect(state.caret).toBe(0);

    const frame = pagerView({
      ink: colorInk,
      columns: 80,
      rows: 8,
      title: "t",
      lines,
      state,
    });
    expect(panelFrameRows(frame).rows[1]).toContain("\x1b[7m");
  });
});

describe("pager keys", () => {
  it("moves by line, page, and to the ends", () => {
    expect(press(PAGER_INITIAL_STATE, "j").state.caret).toBe(1);
    expect(press(PAGER_INITIAL_STATE, "down").state.caret).toBe(1);
    expect(press(PAGER_INITIAL_STATE, "pagedown").state.caret).toBe(6);
    expect(press(PAGER_INITIAL_STATE, "shift+g").state.caret).toBe(11);
    expect(press({ ...PAGER_INITIAL_STATE, caret: 5 }, "g").state.caret).toBe(0);
  });

  it("keeps the caret inside the window", () => {
    let state = PAGER_INITIAL_STATE;
    for (let i = 0; i < 11; i += 1) state = press(state, "j").state;
    expect(state.caret).toBe(11);
    expect(state.top).toBe(11 - 6 + 1);
  });

  it("runs a find and steps matches with n and N", () => {
    let state = press(PAGER_INITIAL_STATE, "ctrl+r").state;
    expect(state.finding).toBe(true);
    state = press(state, "l", "l").state;
    state = press(state, "i", "i").state;
    state = press(state, "n", "n").state;
    state = press(state, "e", "e").state;
    expect(state.draft).toBe("line");
    state = press(state, "enter").state;
    expect(state.finding).toBe(false);
    expect(state.query).toBe("line");
    expect(state.caret).toBe(0);
    state = press(state, "n").state;
    expect(state.caret).toBe(1);
    state = press(state, "shift+n").state;
    expect(state.caret).toBe(0);
  });

  it("escapes the find prompt without changing the query", () => {
    const state = press({ ...PAGER_INITIAL_STATE, query: "line" }, "ctrl+r").state;
    const escaped = press(state, "escape").state;
    expect(escaped.finding).toBe(false);
    expect(escaped.query).toBe("line");
  });

  it("paints matches inverse", () => {
    const colored = pagerView({
      ink: colorInk,
      columns: 80,
      rows: 8,
      title: "t",
      lines: pagerLines(BODY, 80, 8, PAGER_INITIAL_STATE.format),
      state: { ...PAGER_INITIAL_STATE, query: "line 1" },
    });
    expect(panelFrameRows(colored).rows[1]).toContain("\x1b[7m");
  });

  it("toggles format and follow", () => {
    expect(press(PAGER_INITIAL_STATE, "r").state.format).toBe("raw");
    expect(press({ ...PAGER_INITIAL_STATE, format: "raw" }, "f").state.format).toBe("formatted");
    const live = pagerKey({
      state: PAGER_INITIAL_STATE,
      chord: "l",
      lines: pagerLines(BODY, 80, 8, PAGER_INITIAL_STATE.format),
      rows: 8,
      live: true,
      body: BODY,
    });
    expect(live.state.follow).toBe(true);
  });

  it("exports, copies, and closes through effects", () => {
    expect(press(PAGER_INITIAL_STATE, "s").effects).toEqual([
      { kind: "pager-export-scrollback" },
    ]);
    expect(press(PAGER_INITIAL_STATE, "e").effects).toEqual([
      { kind: "pager-export-editor" },
    ]);
    expect(press(PAGER_INITIAL_STATE, "c").effects).toEqual([
      { kind: "copy", text: BODY },
    ]);
    expect(press(PAGER_INITIAL_STATE, "q").effects).toEqual([{ kind: "close" }]);
    expect(press(PAGER_INITIAL_STATE, "ctrl+w").handled).toBe(false);
  });
});

describe("pager controller wiring", () => {
  it("starts formatted for forced markdown and raw for plain mode", () => {
    const harness = createHarness();
    const body = "# Heading\n\n**bold** text";
    expect(harness.overlay.openPager("docs", body, undefined, undefined, "force")).toBe(true);
    expect(harness.panels.getSnapshot().pager.format).toBe("formatted");
    harness.overlay.close();
    expect(harness.overlay.openPager("docs", body, undefined, undefined, "plain")).toBe(true);
    expect(harness.panels.getSnapshot().pager.format).toBe("raw");
  });

  it("copies the body and closes on q", async () => {
    const harness = createHarness();
    harness.overlay.openPager("out", BODY);
    expect(harness.press("c")).toBe(true);
    await Promise.resolve();
    expect(harness.copied).toEqual([BODY]);
    expect(harness.press("q")).toBe(true);
    expect(harness.overlay.isOpen()).toBe(false);
  });

  it("exports through the injected ports", () => {
    const harness = createHarness();
    harness.overlay.openPager("out", BODY);
    harness.press("s");
    harness.press("e");
    expect(harness.exports).toEqual([`scrollback:${BODY}`, `editor:${BODY}`]);
  });
});
