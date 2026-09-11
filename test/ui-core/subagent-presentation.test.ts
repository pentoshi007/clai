import { describe, expect, it } from "vitest";
import { subagentLineSpans } from "../../src/ui-core/rendering/subagent-presentation.js";

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
