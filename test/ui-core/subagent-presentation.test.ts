import { describe, expect, it } from "vitest";
import { renderSubagentMarkdownLines, subagentLineSpans, styleSubagentBody } from "../../src/ui-core/rendering/subagent-presentation.js";
import { stripAnsiSequences } from "../../src/ui-core/rendering/sanitize-display.js";

describe("subagent semantic colors", () => {
  it.each([
    ["→ fs.read src/index.ts (offset=4)", "activity"],
    ["✓ fs.read src/index.ts (offset=4)", "success"],
    ["✗ web.fetch https://example.test", "diffDel"],
  ])("styles the status, tool, and arguments independently: %s", (line, color) => {
    const spans = subagentLineSpans(line!);
    expect(spans?.map((span) => span.text).join("")).toBe(line);
    expect(spans?.map((span) => span.fg)).toEqual([color, "cyan", "muted"]);
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
        "\x1b[31m→ \x1b[0m\x1b[31mfs.read\x1b[0m\x1b[37m src/index.ts (offset=4)\x1b[0m",
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
  it("preserves literal tool arguments and their color through wrapping", () => {
    const argumentsText = "printf '**literal** `argument` <br> # heading | column' " + "docs/path_with_underscores/".repeat(5);
    const continuation = "  # fs.read file=1/2\n  12 │ **second** `input`\n  ```tool\n  </p><p>unchanged\n  ```";
    const body = `## Activity\n\n→ shell.exec ${argumentsText}\n${continuation}\n  In progress\n\nA **verified** finding.`;
    const painted: Array<{ text: string; fg: string }> = [];
    const rows = renderSubagentMarkdownLines(body, { width: 38, stripOuterIndent: true, colorMode: "truecolor" }, (span) => {
      painted.push(span);
      return `\x1b[${span.fg === "muted" ? 37 : 31}m${span.text}\x1b[0m`;
    });
    const plain = rows.map(stripAnsiSequences);
    expect(plain.join("")).toContain(`→ shell.exec ${argumentsText}${continuation.replace(/\n/g, "")}`);
    expect(plain.join("\n")).toContain("A verified finding.");
    expect(plain.filter((row) => !row.trim())).toHaveLength(2);
    expect(painted.filter((span) => span.fg === "muted").map((span) => span.text).join("")).toBe(` ${argumentsText}${continuation.replace(/\n/g, "")}`);
    expect(painted.find((span) => span.text === "shell.exec")).toMatchObject({ fg: "cyan", bold: true });
    expect(plain.some((row) => /╭|╰/.test(row))).toBe(false);
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
