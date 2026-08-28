import { describe, expect, it } from "vitest";
import { collapseRepeatedText } from "../../src/agent/tool-call-parser.js";
import { renderMarkdown } from "../../src/ui-core/rendering/markdown.js";
import { stripAnsiSequences } from "../../src/ui-core/rendering/sanitize-display.js";

function longUniquePrefix(): string {
  return Array.from(
    { length: 220 },
    (_, index) => `verified-context-${index}`,
  ).join(" ");
}

describe("collapseRepeatedText Markdown safety", () => {
  it("does not corrupt a wide Markdown table delimiter before rendering", () => {
    const table = [
      "| # | Title | URL | Last updated |",
      "| --- | ----- | -------------------------------------------- | ------------ |",
      "| 1 | Building a SOC lab | building-a-real-soc-lab | 2026-05-27 |",
    ].join("\n");
    const input = `${longUniquePrefix()}\n\n${table}`;

    const collapsed = collapseRepeatedText(input);

    expect(collapsed).toContain(table);
    expect(collapsed).not.toContain("[repeated");
    const rendered = stripAnsiSequences(renderMarkdown(collapsed, 100));
    expect(rendered).toContain("┌");
    expect(rendered).toContain("│ #");
    expect(rendered).toContain("building-a-real-soc-lab");
  });

  it("preserves other structured Markdown that resembles repetition", () => {
    const structured = [
      "| Kind | A | B | C | D | E | F | G |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| same | same | same | same | same | same | same | same |",
      "",
      "------------------------------------",
      "",
      "Symbols: ============================== remain exact.",
      "",
      "```ts",
      "const value = 1; const value = 1; const value = 1; const value = 1; const value = 1; const value = 1; const value = 1; const value = 1;",
      "```",
    ].join("\n");
    const input = `${longUniquePrefix()}\n\n${structured}`;

    expect(collapseRepeatedText(input)).toBe(input);
  });

  it("still bounds genuinely pathological repeated prose, including lines", () => {
    const repeatedLine = "Waiting for the service to become ready.\n";
    const input = `${longUniquePrefix()}\n\n${repeatedLine.repeat(30)}`;

    const collapsed = collapseRepeatedText(input);

    expect(collapsed.length).toBeLessThan(input.length);
    expect(collapsed).toMatch(/\[repeated ~\d+× — collapsed\]/);
    expect(collapsed.match(/Waiting for the service/g)?.length).toBe(3);
  });
});
