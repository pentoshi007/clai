import { describe, expect, it } from "vitest";
import { resolveShellExecBackgroundPolicy } from "../src/tools/command-intent.js";
import { getToolDefinition } from "../src/tools/definitions.js";
import { renderAgentSystemPrompt, renderCompactAgentSystemPrompt } from "../src/prompts/index.js";
import { compileRequestPlan } from "../src/llm/request-plan.js";
import type { ChatMessage } from "../src/types.js";

const toolList = "shell.exec, shell.wait, shell.tail, shell.stop, job.read, tool.check";
const variants = [
  ["legacy", () => renderAgentSystemPrompt(toolList, { stableEnvironment: true })],
  ["native", () => renderAgentSystemPrompt(toolList, { nativeTools: true, slimNative: false, stableEnvironment: true })],
  ["slim native", () => renderAgentSystemPrompt(toolList, { nativeTools: true, slimNative: true, stableEnvironment: true })],
  ["compact legacy", () => renderCompactAgentSystemPrompt(toolList, { stableEnvironment: true })],
  ["compact native", () => renderCompactAgentSystemPrompt(toolList, { nativeTools: true, stableEnvironment: true })],
] as const;

describe("stable execution guidance", () => {
  it.each(variants)("%s explains explicit execution and follow-up", (_name, render) => {
    const prompt = render();
    expect(prompt).toContain("Commands are never automatically backgrounded");
    expect(prompt).toContain('background:"always"');
    expect(prompt).toContain('background:"never"');
    expect(prompt).toContain("responder:true");
    expect(prompt).toMatch(/milliseconds \(1000–1800000[);]/);
    expect(prompt).toContain("60000");
    expect(prompt).toMatch(/ignored for background and Responder/);
    expect(prompt).toContain("shell.wait");
    expect(prompt).toContain("readiness probe");
    expect(prompt).toContain("job.read");
    expect(prompt).not.toMatch(/auto-background as|auto-launch|safe automatic budget/);
  });

  it("schemas expose the full execution contract without changing the catalog per call", () => {
    const shell = getToolDefinition("shell.exec")!;
    expect(shell.description).toContain("never automatically backgrounded");
    expect(shell.description).toContain("Foreground default is 60000");
    expect(shell.parameters.properties.timeoutMs).toMatchObject({ minimum: 1_000, maximum: 1_800_000 });
    expect(shell.parameters.properties.timeoutMs.description).toContain("default 60000");
    expect(shell.parameters.properties.background).toMatchObject({ enum: ["auto", "never", "always"] });
    expect(shell.description).toContain("timeoutMs is ignored for background and Responder jobs");
    expect(shell.parameters.properties.timeoutMs.description).toContain("Ignored for background and Responder jobs");
    expect(getToolDefinition("tool.check")!.parameters.properties.tools).toMatchObject({ maxItems: 40 });
  });

  it.each(variants)("%s preserves cached instructions and tools across execution choices", (_name, render) => {
    const tools = [getToolDefinition("shell.exec")!, getToolDefinition("tool.check")!];
    const serializedTools = JSON.stringify(tools);
    const prefix: ChatMessage[] = [
      { role: "system", content: render() },
      { role: "user", content: "previous request" },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "run the checks" },
    ];
    const common = { provider: "openai" as const, model: "gpt-5", stream: true, tools };
    const initial = compileRequestPlan({ ...common, messages: prefix });
    const messages = [...prefix];
    const choices = [
      { command: "tcpdump -c 1", timeoutMs: 60_000 },
      { command: "echo done", timeoutMs: 120_000, background: "always" },
      { command: "echo done", timeoutMs: 180_000, responder: true },
    ];
    for (const [index, args] of choices.entries()) {
      resolveShellExecBackgroundPolicy(args);
      const id = `execution-${index}`;
      messages.push({ role: "assistant", content: "", toolCalls: [{ id, name: "shell.exec", args }] });
      messages.push({ role: "tool", name: "shell.exec", toolCallId: id, content: "execution receipt" });
      const next = compileRequestPlan({ ...common, messages });
      expect(next.cache.fingerprint.prefixSha256).toBe(initial.cache.fingerprint.prefixSha256);
      expect(next.cache.fingerprint.prefixMessageCount).toBe(initial.cache.fingerprint.prefixMessageCount);
      expect(JSON.stringify(next.tools.definitions)).toBe(serializedTools);
      expect(messages[0]?.content).toBe(prefix[0]?.content);
      expect(render()).toBe(prefix[0]?.content);
    }
  });
});
