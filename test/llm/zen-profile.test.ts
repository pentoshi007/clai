import { describe, expect, it, vi } from "vitest";
import type { CompletionRequest } from "../../src/types.js";
import { compactMessagesWithSummary } from "../../src/agent/context-manager.js";
import { withZenProfile, ZEN_AGENT_TOOLS } from "../../src/llm/zen-profile.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";
import { normalizeToolCall } from "../../src/tools/registry.js";

const model = "deepseek-v4.1-flash-free";
const tools = getToolDefinitions({ names: ["fs.read", "fs.edit", "shell.exec", "task.update", "mcp.call"] });

function request(): CompletionRequest {
  return {
    model: `free-1/${model}`,
    messages: [
      { role: "system", content: "Stable clai rules" },
      { role: "user", content: "Read package.json" },
    ],
    tools,
    toolChoice: "auto",
  };
}

function system(input: CompletionRequest): string {
  return input.messages.find((message) => message.role === "system")!.content;
}

describe("Zen runtime tool contract", () => {
  it("retains the exact compatibility tools and appends real native schemas", () => {
    const input = request();
    const before = structuredClone(input);
    const prepared = withZenProfile(input, model);
    expect(prepared.tools?.slice(0, ZEN_AGENT_TOOLS.length)).toEqual(ZEN_AGENT_TOOLS);
    for (const tool of tools) expect(prepared.tools).toContainEqual(tool);
    expect(system(prepared)).toContain("CLAI RUNTIME TOOL CONTRACT");
    expect(system(prepared)).toContain("shell_exec");
    expect(system(prepared)).toContain("timeoutMs");
    expect(system(prepared)).toContain("not executable");
    expect(input).toEqual(before);
  });

  it("preserves the prefix and schemas after actual compaction", async () => {
    const input = request();
    input.messages.push(
      { role: "assistant", content: "Old tool failures included grep, execute and shell." },
      { role: "user", content: "Continue with the correct native tools." },
      { role: "assistant", content: "I will read package.json." },
      { role: "user", content: "Continue" },
    );
    const before = withZenProfile(input, model);
    const compacted = await compactMessagesWithSummary(
      input.messages,
      async () => "## Work\nInvestigated old tool failures.\n## Next\nRead package.json with the correct native tools.",
      { budgetTokens: 0, keepRecent: 2 },
    );
    expect(compacted.summarized).toBe(true);
    const after = withZenProfile({ ...input, messages: compacted.messages }, model);
    expect(system(after)).toBe(system(before));
    expect(after.tools).toEqual(before.tools);
    expect(system(after)).toContain("CLAI RUNTIME TOOL CONTRACT");
    expect(after.tools).toContainEqual(tools.find((tool) => tool.name === "shell.exec"));
    expect(after.tools).toContainEqual(tools.find((tool) => tool.name === "fs.edit"));
  });

  it("keeps native tool order and contract stable when the input order changes", () => {
    const first = withZenProfile(request(), model);
    const reordered = withZenProfile({ ...request(), tools: [...tools].reverse() }, model);
    expect(reordered.tools).toEqual(first.tools);
    expect(system(reordered)).toBe(system(first));
  });

  it("does not expose native tools in a tool-less or explicitly disabled request", () => {
    for (const input of [{ ...request(), tools: undefined }, { ...request(), toolChoice: "none" as const }]) {
      const prepared = withZenProfile(input, model);
      expect(prepared.tools).toBeUndefined();
      expect(prepared.toolChoice).toBeUndefined();
      expect(system(prepared)).not.toContain("CLAI RUNTIME TOOL CONTRACT");
      expect(system(prepared).startsWith("You are a title generator.")).toBe(true);
    }
  });

  it("canonicalizes legacy names in streaming callbacks without changing other events", () => {
    const onToolCallDelta = vi.fn();
    const onStreamEvent = vi.fn();
    const prepared = withZenProfile({ ...request(), onToolCallDelta, onStreamEvent }, model);
    prepared.onToolCallDelta?.({ index: 0, id: "call-1", name: "shell", argumentsBytes: 10 });
    prepared.onStreamEvent?.({ type: "tool_call_started", index: 0, id: "call-1", name: "shell" });
    prepared.onStreamEvent?.({ type: "tool_call_completed", index: 0, id: "call-1", name: "shell" });
    prepared.onStreamEvent?.({ type: "answer_delta", text: "ok" });
    expect(onToolCallDelta).toHaveBeenCalledWith({ index: 0, id: "call-1", name: "shell.exec", argumentsBytes: 10 });
    expect(onStreamEvent.mock.calls.map(([event]) => event)).toEqual([
      { type: "tool_call_started", index: 0, id: "call-1", name: "shell.exec" },
      { type: "tool_call_completed", index: 0, id: "call-1", name: "shell.exec" },
      { type: "answer_delta", text: "ok" },
    ]);
  });

  it("translates old shell history to native arguments instead of prefixing commands", () => {
    const input = request();
    input.messages.push(
      {
        role: "assistant", content: "", toolCalls: [{
          id: "shell-1", name: "shell",
          args: { command: "printf ok", workdir: "/tmp", timeout: 120_000, background: true },
          rawArguments: '{"command":"printf ok","workdir":"/tmp","timeout":120000,"background":true}',
        }],
      },
      { role: "tool", toolCallId: "shell-1", name: "shell", content: "ok" },
    );
    const prepared = withZenProfile(input, model);
    const call = prepared.messages[2]!.toolCalls![0]!;
    expect(call.name).toBe("shell.exec");
    expect(call.args).toEqual({ command: "printf ok", cwd: "/tmp", timeoutMs: 120_000, background: "always" });
    expect(JSON.parse(call.rawArguments!)).toEqual(call.args);
    expect(normalizeToolCall(call).args.command).toBe("printf ok");
    expect(prepared.messages[3]!.name).toBe("shell.exec");
    expect(prepared.messages[3]!.toolCallId).toBe("shell-1");
    expect(input.messages[2]!.toolCalls![0]!.name).toBe("shell");
  });
});
