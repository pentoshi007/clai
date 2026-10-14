import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderAgentSystemPrompt, renderCompactAgentSystemPrompt } from "../src/prompts/index.js";

const heading = "# PERSISTENT PROJECT INSTRUCTIONS";
const source = readFileSync(new URL("../src/prompts/system.agent.md", import.meta.url), "utf8");
const policy = source.slice(source.indexOf(heading), source.indexOf("# ATTACHED REFERENCES")).trim();
const tools = "instructions.record, fs.read, shell.exec";
const variants = [
  ["text", () => renderAgentSystemPrompt(tools)],
  ["full native", () => renderAgentSystemPrompt(tools, { nativeTools: true, slimNative: false })],
  ["slim native", () => renderAgentSystemPrompt(tools, { nativeTools: true, slimNative: true })],
  ["default native", () => renderAgentSystemPrompt(tools, { nativeTools: true })],
  ["compact text", () => renderCompactAgentSystemPrompt(tools)],
  ["compact native", () => renderCompactAgentSystemPrompt(tools, { nativeTools: true })],
] as const;

describe("project instruction scope in agent prompt variants", () => {
  it.each(variants)("retains the complete persistence policy exactly once in %s", (name, render) => {
    const prompt = render();
    expect(prompt.split(heading).length - 1).toBe(1);
    expect(prompt.includes(policy)).toBe(true);
    expect(prompt.includes('scope="project"')).toBe(true);
    expect(prompt.includes("skip instructions.record entirely")).toBe(true);
    if (name.includes("native")) expect(prompt.includes("```tool")).toBe(false);
  });
});
