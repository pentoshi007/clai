import { describe, expect, it } from "vitest";
import { buildPagerRows, pagerRowSearch, pagerRowWindow, slicePagerSpans } from "../../src/tui-v2/components/pager/pager-rows.js";
import { renderColumns } from "../../src/ui-core/rendering/text-width.js";
import { subagentBodySpans } from "../../src/ui-core/rendering/subagent-presentation.js";

describe("continuous pager rows", () => {
  it("keeps every wrapped command character and its semantic color", () => {
    const line = `✓ Shell inspect ${"docs/日本語-🔬/".repeat(60)}report.md --full`;
    const lines = [line];
    const rows = buildPagerRows({
      display: { mode: "plain", lines: lines.map((plain) => ({ plain })) },
      lines, contentCols: 40, useDiffGutters: false, isSubagent: true, highlightPath: "", wrapRows: true,
    });
    const spans = subagentBodySpans(lines)[0]!;
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.map((row) => row.line).join("")).toBe(line);
    for (const row of rows) {
      expect(renderColumns(row.line)).toBeLessThanOrEqual(40);
      const painted = slicePagerSpans(spans, row.textOffset!, row.line.length);
      expect(painted.map((span) => span.text).join("")).toBe(row.line);
      if (row.textOffset! > line.indexOf("inspect")) {
        expect(painted.every((span) => span.fg === "inputBorder")).toBe(true);
      }
    }
  });

  it("marks the shell.exec command block as input and leaves output untoned", () => {
    const lines = ["command: for f in *; do", "  echo $f", "done", "", "file1.txt", "file2.txt"];
    const rows = buildPagerRows({
      display: { mode: "plain", lines: lines.map((plain) => ({ plain })) },
      lines, contentCols: 80, useDiffGutters: false, isSubagent: false, highlightPath: "",
    });
    const toneByIndex = new Map(rows.map((row) => [row.index, row.tone]));
    expect(toneByIndex.get(0)).toBe("input");
    expect(toneByIndex.get(1)).toBe("input");
    expect(toneByIndex.get(2)).toBe("input");
    expect(toneByIndex.get(4)).toBeUndefined();
    expect(toneByIndex.get(5)).toBeUndefined();
    expect(rows.every((row) => row.spans === undefined)).toBe(true);
  });

  it("syntax-highlights fs.read file body but not its header or trailing note", () => {
    const lines = [
      "file: /tmp/sample.ts", "", "const answer = 42;", "function greet() {}", "",
      "── full file ──", "/tmp/sample.ts",
    ];
    const rows = buildPagerRows({
      display: { mode: "plain", lines: lines.map((plain) => ({ plain })) },
      lines, contentCols: 80, useDiffGutters: true, isSubagent: false, highlightPath: "/tmp/sample.ts",
    });
    const byIndex = (index: number) => rows.find((row) => row.index === index)!;
    const codeSpans = byIndex(2).spans;
    expect(codeSpans?.some((span) => span.kind === "keyword")).toBe(true);
    expect(codeSpans?.some((span) => span.kind === "number")).toBe(true);
    expect(byIndex(3).spans?.some((span) => span.kind === "keyword")).toBe(true);
    expect(byIndex(0).spans).toBeUndefined();
    expect(byIndex(5).spans).toBeUndefined();
    expect(byIndex(6).spans).toBeUndefined();
    expect(rows.every((row) => row.tone === undefined)).toBe(true);
  });

  it("bounds mounting at every scroll position and clamps a shrinking transcript", () => {
    for (const top of [0, 500, 100_000]) {
      const window = pagerRowWindow(100_000, top, 30);
      expect(window.end - window.start).toBeLessThanOrEqual(90);
      expect(window.start).toBeGreaterThanOrEqual(0);
      expect(window.end).toBeLessThanOrEqual(100_000);
    }
    expect(pagerRowWindow(12, 100_000, 30)).toEqual({ start: 0, end: 12 });
    expect(pagerRowWindow(0, 0, 30)).toEqual({ start: 0, end: 0 });
  });

  it("highlights both halves of a match crossing a wrapped row", () => {
    const matches = [{ line: 9, column: 37, length: 8 }, { line: 9, column: 70, length: 4 }];
    const search = { matches, active: 0 };
    expect(pagerRowSearch(search, 0, 40)).toEqual({
      matches: [{ line: 9, column: 37, length: 3 }], active: 0,
    });
    expect(pagerRowSearch(search, 40, 40)).toEqual({
      matches: [{ line: 9, column: 0, length: 5 }, { line: 9, column: 30, length: 4 }], active: 0,
    });
    expect(pagerRowSearch(search, 80, 40)).toEqual({ matches: [], active: -1 });
  });
});
