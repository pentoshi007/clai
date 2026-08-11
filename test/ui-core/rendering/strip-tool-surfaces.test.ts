import { describe, expect, it } from "vitest";
import {
  isToolFenceOnlyText,
  stripToolCallSurfaces,
} from "../../../src/ui-core/rendering/strip-tool-surfaces.js";

describe("stripToolCallSurfaces", () => {
  it("removes complete tool fences and keeps prose", () => {
    const raw =
      "Here is the plan.\n\n```tool\n" +
      '{"name":"shell.exec","args":{"command":"ls"}}\n' +
      "```\n\nDone.";
    expect(stripToolCallSurfaces(raw)).toContain("Here is the plan.");
    expect(stripToolCallSurfaces(raw)).toContain("Done.");
    expect(stripToolCallSurfaces(raw)).not.toContain("shell.exec");
  });

  it("strips incomplete trailing fences while streaming", () => {
    const raw =
      "Excellent recon.\n\n```tool\n" +
      '{"name":"shell.exec","args":{"command":"echo hi';
    const stripped = stripToolCallSurfaces(raw);
    expect(stripped).toContain("Excellent recon.");
    expect(stripped).not.toContain("```tool");
    expect(stripped).not.toContain("shell.exec");
  });

  it("removes complete and partial DSML tool surfaces", () => {
    const complete = `Inspecting.\n<｜DSML｜tool_calls><｜DSML｜invoke name="fs.list"><｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`;
    expect(stripToolCallSurfaces(complete).trim()).toBe("Inspecting.");
    expect(
      isToolFenceOnlyText(
        `<|DSML|tool_calls><|DSML|invoke name="fs.list"><|DSML|parameter name="path" string="true">.`,
      ),
    ).toBe(true);
  });

  it("removes stranded DSML tags left after a settled block", () => {
    expect(stripToolCallSurfaces("Guard added.</｜DSML｜invoke>\nNext step.")).toBe(
      "Guard added.\nNext step.",
    );
    expect(
      stripToolCallSurfaces(
        `<｜DSML｜parameter name="path" string="true">.</｜DSML｜parameter>\nListing now.`,
      ).trim(),
    ).toBe("Listing now.");
  });

  it("detects fence-only text", () => {
    expect(
      isToolFenceOnlyText(
        '```tool\n{"name":"fs.list","args":{"path":"."}}\n```',
      ),
    ).toBe(true);
    expect(isToolFenceOnlyText("Just prose.")).toBe(false);
  });

  it("hides a DSML opener that is still mid-tag at the stream edge", () => {
    expect(stripToolCallSurfaces("Thinking. <｜DSML")).toBe("Thinking. ");
    expect(stripToolCallSurfaces("Thinking. <|DSML|inv")).toBe("Thinking. ");
    expect(stripToolCallSurfaces("Thinking. <|DSML|invoke name=\"fs.wri")).toBe("Thinking. ");
  });

  it("hides a sentinel opener whose arg parens have not closed yet", () => {
    const stripped = stripToolCallSurfaces(
      "Reviewing.\ninvoke_tool(\"fs.write\", {\"path\": \"/repo/a.ts\", \"content\": \"long body no paren yet",
    );
    expect(stripped).not.toContain("invoke_tool");
    expect(stripped.trim()).toBe("Reviewing.");
  });

  it("never hides plain prose that merely contains an angle bracket", () => {
    expect(stripToolCallSurfaces("a < b and c < d")).toBe("a < b and c < d");
  });
});
