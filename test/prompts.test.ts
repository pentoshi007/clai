import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  renderAskSystemPrompt,
  renderAgentSystemPrompt,
  _ASK_TEMPLATE,
  _AGENT_TEMPLATE,
  currentDateTimeContext,
} from "../src/prompts/index.js";

describe("prompt rendering", () => {
  it("ask prompt contains /ask mode instruction", () => {
    const prompt = renderAskSystemPrompt();
    expect(prompt).toContain("/ask mode");
    expect(prompt).toContain("Do NOT execute");
  });

  it("ask prompt includes OS info and current date/time", () => {
    const prompt = renderAskSystemPrompt();
    // Should have replaced the {{os}} template
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
    expect(prompt).toContain("Current date/time:");
  });

  it("agent prompt includes tool list", () => {
    const prompt = renderAgentSystemPrompt("shell.exec, fs.read, sysinfo");
    expect(prompt).toContain("shell.exec");
    expect(prompt).toContain("fs.read");
    expect(prompt).toContain("sysinfo");
  });

  it("agent prompt has no unresolved template variables", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    expect(prompt).not.toContain("{{os}}");
    expect(prompt).not.toContain("{{cwd}}");
    expect(prompt).not.toContain("{{tool_list}}");
    expect(prompt).not.toContain("{{shell}}");
    expect(prompt).not.toContain("{{datetime}}");
  });

  it("agent prompt contains pentesting authorization reminder", () => {
    const prompt = renderAgentSystemPrompt("net.scan");
    expect(prompt).toContain("proper authorization");
  });

  it("agent prompt discourages stale data and vague tool summaries", () => {
    const prompt = renderAgentSystemPrompt("shell.exec");
    expect(prompt).toContain("Do not invent volatile live data");
    expect(prompt).toContain("office holders");
    expect(prompt).toContain("If your knowledge may be stale");
    expect(prompt).toContain("newest timeline");
    expect(prompt).toContain("summarize concrete findings");
    expect(prompt).toContain("For ffuf");
  });

  it("formats date/time context with an ISO timestamp", () => {
    const when = new Date("2026-05-29T12:34:56.000Z");
    expect(currentDateTimeContext(when)).toContain("2026-05-29T12:34:56.000Z");
  });
});

describe("phase 11 — prompt template ↔ markdown drift", () => {
  it("system.ask.md content matches the inline ask template", () => {
    const md = readFileSync(
      resolve(__dirname, "../src/prompts/system.ask.md"),
      "utf8",
    )
      .replace(/\r\n/g, "\n")
      .trimEnd();
    const inline = _ASK_TEMPLATE.replace(/\r\n/g, "\n").trimEnd();
    expect(md).toBe(inline);
  });

  it("system.agent.md content matches the inline agent template", () => {
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
