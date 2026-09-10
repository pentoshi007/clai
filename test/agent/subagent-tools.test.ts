import { describe, expect, it, vi } from "vitest";
import { runSubagentTool, orchestrationContext } from "../../src/agent/subagents/tools.js";
import type { SubagentManager } from "../../src/agent/subagents/manager.js";
import type { SubagentRun } from "../../src/agent/subagents/types.js";
import { runSingleTool } from "../../src/agent/turn/tool-execution/single-tool.js";
import type { SingleToolDeps } from "../../src/agent/turn/tool-execution/deps.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { runToolCall, availableToolNames } from "../../src/tools/registry.js";
import { getToolDefinitions, getCompactToolDefinitions } from "../../src/tools/definitions.js";
import { SUBAGENT_TOOL_NAMES } from "../../src/tools/definitions/subagents.js";
import { renderAgentSystemPrompt } from "../../src/prompts/index.js";
import { composeTurnMessages } from "../../src/agent/turn/setup/turn-messages.js";
import { buildTurnHistory } from "../../src/agent/tool-call-parser.js";
import type { ChatMessage } from "../../src/types.js";

const run: SubagentRun = {
  id: "child-1", parentSessionId: "parent", title: "Inspect routes", prompt: "Find relevant routes",
  cwd: process.cwd(), provider: "openai", model: "gpt-4.1", attempt: 1,
  status: "completed", createdAt: 1, updatedAt: 2, report: "src/routes.ts:12 validates ownership",
  events: [1, 2, 3, 4].map((sequence) => ({ sequence, kind: "assistant", text: `message ${sequence}`, timestamp: sequence })),
};

function fixture(enabled = true) {
  const manager = {
    enabled, start: vi.fn(() => run), list: vi.fn(() => [run]), get: vi.fn(() => run),
    stop: vi.fn(), restart: vi.fn(() => run), wait: vi.fn(async () => run),
  };
  const context = { manager: manager as unknown as SubagentManager, provider: "openai" as const, model: "gpt-4.1", cwd: process.cwd() };
  return { manager, context, signal: new AbortController().signal };
}

function data(output: string): Record<string, any> {
  return JSON.parse(output.slice(output.indexOf("\n") + 1));
}

describe("parent subagent tool boundary", () => {
  it.each(SUBAGENT_TOOL_NAMES)("rejects %s when orchestration is disabled", async (name) => {
    const { manager, context, signal } = fixture(false);
    const result = await runSubagentTool({ name, args: { id: run.id, title: run.title, prompt: run.prompt } }, context, signal);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("ORCHESTRATION: OFF");
    for (const method of [manager.start, manager.list, manager.get, manager.stop, manager.restart, manager.wait]) expect(method).not.toHaveBeenCalled();
  });

  it("starts with the parent route and root, not model-provided overrides", async () => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.start", args: { title: run.title, prompt: run.prompt, cwd: "/", model: "other" } }, context, signal);
    expect(result.ok).toBe(true);
    expect(manager.start).toHaveBeenCalledWith({ title: run.title, prompt: run.prompt, context: undefined, cwd: process.cwd(), provider: "openai", model: "gpt-4.1" });
  });

  it("defaults to three recent conversation events and reads reports separately", async () => {
    const { context, signal } = fixture();
    const tail = await runSubagentTool({ name: "subagent.read", args: { id: run.id } }, context, signal);
    expect(data(tail.output).events.map((event: { sequence: number }) => event.sequence)).toEqual([2, 3, 4]);
    expect(data(tail.output).report).toBeUndefined();
    const report = await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report" } }, context, signal);
    expect(data(report.output).report).toBe(run.report);
  });

  it("caps tail output even after its character budget is exhausted", async () => {
    const { manager, context, signal } = fixture();
    manager.get.mockReturnValue({ ...run, events: run.events.map((event) => ({ ...event, text: "x".repeat(13000) })) });
    const result = await runSubagentTool({ name: "subagent.read", args: { id: run.id, limit: 4 } }, context, signal);
    expect(data(result.output).events.reduce((n: number, event: { text: string }) => n + event.text.length, 0)).toBe(12000);
  });

  it.each([0, -1, 1.5, 21, "3"])("rejects invalid read limit %s", async (limit) => {
    const { context, signal } = fixture();
    expect((await runSubagentTool({ name: "subagent.read", args: { id: run.id, limit } }, context, signal)).ok).toBe(false);
  });

  it("does not dispatch registry or batch calls outside the parent boundary", async () => {
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect((await runToolCall({ name, args: { id: run.id, title: run.title, prompt: run.prompt } })).ok).toBe(false);
    }
    const result = await runToolCall({ name: "tool.batch", args: { calls: [{ name: "subagent.start", args: { title: run.title, prompt: run.prompt } }] } }, { confirmed: true });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("directly");
  });

  it("enforces the gate in the real single-tool dispatch before privileged execution", async () => {
    const session = createSessionPolicy("parent");
    const deps = {
      session, provider: () => "openai", model: () => "gpt-4.1",
      alreadyPrintedIds: new Set(), writeToolCall: vi.fn(), emit: vi.fn(), writeToolOutput: vi.fn(), emitToolResult: vi.fn(),
    } as unknown as SingleToolDeps;
    const result = await runSingleTool(deps, { name: "subagent.start", args: { title: run.title, prompt: run.prompt } }, "call-1", new AbortController().signal);
    expect(result.ok).toBe(false);
    expect(result.contextOutput).toContain("ORCHESTRATION: OFF");
    expect(deps.emitToolResult).toHaveBeenCalledOnce();
  });
});

describe("orchestration cache prefix", () => {
  it("retains static tool schemas and system instructions across toggles", () => {
    const toolList = availableToolNames().join(", ");
    const stable = renderAgentSystemPrompt(toolList, { nativeTools: true, stableEnvironment: true });
    const definitions = getToolDefinitions();
    let history: ChatMessage[] | undefined;
    let previous: ChatMessage[] | undefined;
    for (const enabled of [false, true, false, true]) {
      const { messages } = composeTurnMessages({
        prompt: `research with orchestration ${enabled}`, displayPrompt: undefined, images: undefined,
        history, mode: "agent", systemSections: [orchestrationContext(enabled)], selectedSkillNames: [],
        nativeToolsActive: true, inputTokenBudget: undefined, stableSystemContent: () => stable,
        instructionsBlock: undefined, skillsBlock: undefined, plan: undefined, planApproved: false,
      });
      expect(messages[0]?.content).toBe(stable);
      expect(messages[0]?.content).not.toContain("ORCHESTRATION: OFF");
      expect(messages.filter((message) => message.content.includes("ORCHESTRATION:")).at(-1)?.content).toContain(orchestrationContext(enabled));
      expect(getToolDefinitions()).toEqual(definitions);
      if (previous) expect(messages.slice(1, previous.length)).toEqual(previous.slice(1));
      previous = structuredClone(messages);
      history = buildTurnHistory(messages, "research complete");
    }
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect(definitions.some((definition) => definition.name === name)).toBe(true);
      expect(getCompactToolDefinitions().some((definition) => definition.name === name)).toBe(true);
    }
  });
});
