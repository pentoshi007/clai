import { describe, expect, it } from "vitest";
import { renderSubagentMarkdownLines, subagentLineSpans, styleSubagentBody } from "../../src/ui-core/rendering/subagent-presentation.js";
import { stripAnsiSequences } from "../../src/ui-core/rendering/sanitize-display.js";
import { fitOneLine } from "../../src/ui-core/rendering/pager-chrome.js";

describe("subagent semantic colors", () => {
  it.each([
    ["→ Shell printf '**literal**'", "activity"],
    ["✓ Explored", "success"],
    ["✗ Opened https://example.test", "diffDel"],
    ["✓ Searched the web terminal interfaces", "success"],
    ["→ Tools 2 call(s): Shell, Explored", "activity"],
    ["✓ fs.read src/index.ts (offset=4)", "success"],
  ])("styles the status, tool, and arguments independently: %s", (line, color) => {
    const spans = subagentLineSpans(line!);
    expect(spans?.map((span) => span.text).join("")).toBe(line);
    expect(spans?.map((span) => span.fg)).toEqual([color, color, "inputBorder"]);
    expect(spans?.[1]?.bold).toBe(true);
  });

  it.each([
    ["running · attempt 1 · openai/test", "activity"],
    ["completed · attempt 2 · openai/test", "success"],
    ["error · attempt 2 · openai/test", "diffDel"],
    ["## Activity", "magenta"],
    ["Activity", "magenta"],
    ["Findings", "magenta"],
    ["Evidence", "magenta"],
    ["Next steps", "magenta"],
    ["Coverage gaps", "magenta"],
    ["Workspace: /tmp/project", "cyan"],
    ["Notice: Retrying request", "activity"],
    ["  ✗ Request failed", "diffDel"],
    ["  Denied", "diffDel"],
    ["  Failed", "diffDel"],
    ["## Error", "diffDel"],
    ["## Stopped", "activity"],
  ])("gives %s a meaningful color", (line, color) => {
    const spans = subagentLineSpans(line!);
    expect(spans?.[0]?.fg).toBe(color);
    expect(spans?.map((span) => span.text).join("")).toBe(line);
  });

  it.each([
    ["Status: complete", "success"],
    ["Status: partial · investigation unfinished", "activity"],
    ["Status: error", "diffDel"],
  ])("colors report status independently: %s", (line, color) => {
    const spans = subagentLineSpans(line!);
    expect(spans?.map((span) => span.text).join("")).toBe(line);
    expect(spans?.map((span) => span.fg)).toEqual(["cyan", color, "muted"]);
  });

  it.each([
    ["  └ Read src/index.ts", "inputBorder"],
    ["    Read docs/日本語.md", "inputBorder"],
    ["    Read ✗ missing.md", "diffDel"],
  ])("styles option-free read lists: %s", (line, color) => {
    const spans = subagentLineSpans(line!);
    expect(spans?.map(span => span.text).join("")).toBe(line);
    expect(spans?.map(span => span.fg)).toEqual(["toolOutput", color]);
  });

  it("leaves report markdown and unclassified prose to the existing renderer", () => {
    expect(subagentLineSpans("A **verified** finding with `code`.")).toBeUndefined();
    expect(subagentLineSpans("const value = 1;")).toBeUndefined();
  });
});

describe("styleSubagentBody", () => {
  const paint = (span: { text: string; fg: string }): string => `\x1b[${span.fg === "muted" ? 37 : 31}m${span.text}\x1b[0m`;

  it("paints classified lines and leaves unclassified lines untouched", () => {
    const body = ["→ fs.read src/index.ts (offset=4)", "plain prose line"].join("\n");
    expect(styleSubagentBody(body, paint)).toBe(
      [
        "\x1b[31m→ \x1b[0m\x1b[31mfs.read\x1b[0m\x1b[31m src/index.ts (offset=4)\x1b[0m",
        "plain prose line",
      ].join("\n"),
    );
  });

  it("preserves the copy text of every line", () => {
    const body = ["## Activity", "✓ fs.read src/index.ts", "running · attempt 1 · openai/test", "Status: complete"].join("\n");
    expect(styleSubagentBody(body, paint).replace(/\x1b\[\d+m|\x1b\[0m/g, "")).toBe(body);
  });
});

describe("formatted subagent inputs", () => {
  it.each([1, 8, 20, 38, 80, 120])("keeps named usage on one styled row at %i columns", (width) => {
    const input = "printf '**literal** `argument` <br> # heading | column' " + "docs/日本語-🔬/".repeat(5);
    const usage = `→ Shell ${input}`;
    const painted: Array<{ text: string; fg: string }> = [];
    const rows = renderSubagentMarkdownLines(usage, { width }, (span) => {
      painted.push(span);
      return `\x1b[31m${span.text}\x1b[0m`;
    }).map(stripAnsiSequences);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(fitOneLine([usage], width));
    expect(rows[0]).toMatch(/…$/);
    expect(painted.at(-1)).toEqual({ text: "…", fg: "hint" });
    if (width >= 20) expect(painted.find(span => span.text === "Shell")).toMatchObject({ fg: "activity", bold: true });
    if (width >= 38) expect(rows[0]).toContain("**literal**");
  });

  it("keeps read lists compact and literal without treating paths as markdown", () => {
    const path = "docs/**literal**_`argument`/<br>/" + "long-section/".repeat(10);
    const body = `## Activity\n\n✓ Explored\n  └ Read ${path}\n    Read ✗ missing.md\n\nA **verified** finding.`;
    const painted: Array<{ text: string; fg: string }> = [];
    const plain = renderSubagentMarkdownLines(body, { width: 60, stripOuterIndent: true }, span => {
      painted.push(span);
      return span.text;
    }).map(stripAnsiSequences);
    expect(plain).toContain(fitOneLine([`  └ Read ${path}`], 60));
    expect(plain).toContain("    Read ✗ missing.md");
    expect(plain.join("\n")).toContain("A verified finding.");
    expect(painted.find(span => span.text === "✗ missing.md")).toMatchObject({ fg: "diffDel" });
    expect(painted.find(span => span.text.startsWith("docs/"))).toMatchObject({ fg: "inputBorder" });
    expect(plain.filter(row => /Read /.test(row))).toHaveLength(2);
    expect(plain.filter(row => !row.trim())).toHaveLength(2);
    expect(plain.some(row => /╭|╰/.test(row))).toBe(false);
  });

  it("keeps report code fences intact around lines resembling tool calls", () => {
    const body = "## Report\n```text\n✓ shell.exec **example**\n```\nA **verified** result.";
    const rows = renderSubagentMarkdownLines(body, { width: 60, stripOuterIndent: true, colorMode: "truecolor" }, (span) => span.text);
    const plain = rows.map(stripAnsiSequences).join("\n");
    expect(plain).toContain("✓ shell.exec **example**");
    expect(plain).toContain("A verified result.");
    expect(plain).toMatch(/╭|┌/);
    expect(plain).toMatch(/╰|└/);
  });
});
