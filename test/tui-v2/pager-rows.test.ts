import { describe, expect, it } from "vitest";
import { buildPagerRows, pagerRowSearch, pagerRowWindow, slicePagerSpans } from "../../src/tui-v2/components/pager/pager-rows.js";
import { renderColumns } from "../../src/ui-core/rendering/text-width.js";
import { subagentBodySpans } from "../../src/ui-core/rendering/subagent-presentation.js";
import { preparePagerDisplay } from "../../src/tui-v2/rendering/pager-markdown.js";
import { pagerRegionsForPage } from "../../src/ui-core/rendering/pager-regions.js";

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

  const plainRows = (
    body: string,
    options: { highlightPath?: string; regions?: Parameters<typeof buildPagerRows>[0]["regions"]; contentCols?: number } = {},
  ) => {
    const display = preparePagerDisplay({ body, width: 80, mode: "plain", defaultFg: "#ffffff", theme: {} as never, colorMode: "truecolor" } as never);
    const lines = display.lines.map((line) => line.plain);
    return buildPagerRows({
      display, lines, contentCols: options.contentCols ?? 80,
      useDiffGutters: Boolean(options.highlightPath), isSubagent: false,
      highlightPath: options.highlightPath ?? "", regions: options.regions,
    });
  };

  it("tones every shell.exec command line, including blank heredoc lines, and leaves output untoned", () => {
    const body = "command: cat > /tmp/x.sh <<'EOF'\necho one\n\necho two\nEOF\n\nfile1.txt\nfile2.txt";
    const rows = plainRows(body, { regions: { inputEnd: 5 } });
    const toneByIndex = new Map(rows.map((row) => [row.index, row.tone]));
    for (const index of [0, 1, 2, 3, 4]) expect(toneByIndex.get(index)).toBe("running");
    for (const index of [5, 6, 7]) expect(toneByIndex.get(index)).toBeUndefined();
    expect(rows.every((row) => row.spans === undefined)).toBe(true);
  });

  it("leaves pagers without regions untoned and unhighlighted", () => {
    for (const body of ["command: not-a-header\nexit 127\n\nreal output", "✓ anthropic  configured (env)\nStatus  2/3 ready"]) {
      const rows = plainRows(body);
      expect(rows.every((row) => row.tone === undefined && row.spans === undefined)).toBe(true);
    }
  });

  it("syntax-highlights the fs.read code region only, even when the file has box-drawing lines", () => {
    const body = "file: /tmp/sample.ts\n\nconst answer = 42;\n──── section ────\nfunction greet() {}\n\n── full file ──\n/tmp/sample.ts";
    const rows = plainRows(body, { highlightPath: "/tmp/sample.ts", regions: { codeStart: 2, codeEnd: 5 } });
    const byIndex = (index: number) => rows.find((row) => row.index === index)!;
    expect(byIndex(2).spans?.some((span) => span.kind === "keyword")).toBe(true);
    expect(byIndex(2).spans?.some((span) => span.kind === "number")).toBe(true);
    expect(byIndex(3).spans).toBeDefined();
    expect(byIndex(4).spans?.some((span) => span.kind === "keyword")).toBe(true);
    for (const index of [0, 1, 5, 6, 7]) expect(byIndex(index).spans).toBeUndefined();
    expect(rows.every((row) => row.tone === undefined)).toBe(true);
  });

  it("highlights a wrapped code line once so tokens survive the wrap boundary", () => {
    const code = 'const message = "hello world this is long"; function abc() { return 1 }';
    const rows = plainRows(`file: /r/a.ts\n\n${code}`, { highlightPath: "/r/a.ts", regions: { codeStart: 2, codeEnd: 3 }, contentCols: 30 });
    const codeRows = rows.filter((row) => row.index === 2);
    expect(codeRows.length).toBeGreaterThan(1);
    const spans = codeRows.flatMap((row) => row.spans ?? []);
    expect(spans.map((span) => span.text).join("")).toBe(code);
    for (const row of codeRows) expect((row.spans ?? []).map((span) => span.text).join("")).toBe(row.line);
    expect(spans.filter((span) => span.kind === "string").map((span) => span.text).join("")).toBe('"hello world this is long"');
    expect(spans.some((span) => span.kind === "keyword" && span.text === "this")).toBe(false);
  });

  it("highlights every page of a file-backed source past the first", () => {
    const rows = plainRows("path: /srv/app\nport: 8080", { highlightPath: "/r/config.yaml", regions: { codeStart: 0 } });
    expect(rows.every((row) => row.spans !== undefined)).toBe(true);
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

describe("pager regions per page", () => {
  it("applies first-page regions only on the first page unless the source is the raw file", () => {
    const shell = { inputEnd: 3 };
    expect(pagerRegionsForPage(shell, undefined)).toBe(shell);
    expect(pagerRegionsForPage(shell, 0)).toBe(shell);
    expect(pagerRegionsForPage(shell, 65_536)).toBeUndefined();
    expect(pagerRegionsForPage({ codeStart: 0, codeOnEveryPage: true }, 65_536)).toEqual({ codeStart: 0 });
    expect(pagerRegionsForPage(undefined, 0)).toBeUndefined();
  });
});
