import { describe, expect, it } from "vitest";
import {
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
} from "../../src/prompts/index.js";

describe("execution contract", () => {
  it.each([false, true])("retains critical behavior in compact prompts (native=%s)", (nativeTools) => {
    const prompt = renderCompactAgentSystemPrompt("fs.read, fs.edit", { nativeTools });
    expect(prompt).toContain("implement only when directed");
    expect(prompt).toContain("An earlier build request is not permission");
    expect(prompt).toContain("batch only independent work");
    expect(prompt).toContain("continue from its cursor instead of rerunning");
    expect(prompt).toContain("do not upgrade unrelated dependencies");
    expect(prompt).toContain("do not weaken checks");
    expect(prompt).toContain("negative controls");
    expect(prompt).toContain("No finite assessment proves all vulnerabilities were found");
    expect(prompt).toContain("limits to disclose, not evidence of completion");
  });

  it.each([false, true])("keeps full prompts evidence-bound (native=%s)", (nativeTools) => {
    const prompt = renderAgentSystemPrompt("fs.read, fs.edit", { nativeTools, pentest: true });
    expect(prompt).toContain("preserve installed dependency versions");
    expect(prompt).toContain("No finite assessment proves all vulnerabilities were found");
    expect(prompt).toContain("coverage limit to report");
  });
});
