import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  renderAgentSystemPrompt,
  scratchDirFor,
  _AGENT_TEMPLATE,
} from "../src/prompts/index.js";

describe("scratch directory transparency", () => {
  it("scratchDirFor returns a path under tmpdir() for a regular project", () => {
    const scratch = scratchDirFor("/Users/alice/my project");
    const osTmp = tmpdir();
    // The scratch path must live under the OS temp root and end with
    // `clai/<sanitized-project-name>` so it is namespaced and predictable.
    // Spaces in the project name are sanitized to hyphens.
    expect(scratch.startsWith(osTmp)).toBe(true);
    expect(scratch.endsWith(`${sep}clai${sep}my-project`)).toBe(true);
  });

  it("scratchDirFor sanitizes unsafe characters in the project name", () => {
    const scratch = scratchDirFor("/tmp/Some Project! @ 1");
    expect(scratch).not.toMatch(/!/);
    expect(scratch).not.toMatch(/@/);
    expect(scratch).not.toMatch(/ /);
    expect(scratch.startsWith(tmpdir())).toBe(true);
  });

  it("scratchDirFor falls back to a stable name for an empty cwd basename", () => {
    const scratch = scratchDirFor("/");
    expect(scratch).toContain(`${sep}clai${sep}`);
    expect(scratch.startsWith(tmpdir())).toBe(true);
  });

  it("rendered agent prompt contains the resolved scratch path", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    // The renderer uses detectSystem().cwd (which mirrors process.cwd())
    // when resolving the scratch path — recompute the same value so we
    // can assert the rendered prompt includes it.
    const scratch = scratchDirFor(process.cwd());
    expect(prompt).toContain(scratch);
    // The placeholder must have been substituted, not left as a literal.
    expect(prompt).not.toContain("{{scratch}}");
  });

  it("rendered agent prompt exposes the OS temp root and explains it", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    const osTmp = tmpdir();
    expect(prompt).toContain(osTmp);
    expect(prompt).not.toContain("{{tempRoot}}");
    // The explanation must mention at least one platform-specific example so
    // the model does not get confused by an unfamiliar temp root path.
    const mentionsMac = prompt.includes("macOS") || prompt.includes("/var/folders");
    const mentionsLinux = prompt.includes("Linux") || prompt.includes("/tmp");
    expect(mentionsMac || mentionsLinux).toBe(true);
  });

  it("rendered agent prompt preserves the scratch-space guardrails", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    expect(prompt).toContain("create ONE folder under the system temp directory");
    expect(prompt).toContain("keep ALL temporary files there");
    expect(prompt).toContain("never write into the current/project directory");
  });

  it("_AGENT_TEMPLATE stays byte-identical to src/prompts/system.agent.md", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.agent.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _AGENT_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });
});
