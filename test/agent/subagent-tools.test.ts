import { describe, expect, it, vi } from "vitest";
import { runSubagentTool, orchestrationContext } from "../../src/agent/subagents/tools.js";
import { SubagentManager } from "../../src/agent/subagents/manager.js";
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
    waitAny: vi.fn<() => Promise<SubagentRun | undefined>>(async () => run), acknowledgeResult: vi.fn(),
  };
  const context = { manager: manager as unknown as SubagentManager, provider: "openai" as const, model: "gpt-4.1", cwd: process.cwd() };
  return { manager, context, signal: new AbortController().signal };
}

function data(output: string): Record<string, any> {
  return JSON.parse(output.slice(output.indexOf("\n") + 1));
}

it.each(["subagent.read", "subagent.list"])("keeps %s available for recovery while delegation is disabled", async (name) => {
  const { context, signal } = fixture(false);
  const result = await runSubagentTool({ name, args: { id: run.id, view: "report" } }, context, signal);
  expect(result.ok).toBe(true);
});

it("reports a missing stored summary without substituting interrupted activity", async () => {
  const { context, signal } = fixture();
  const result = await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "summary" } }, context, signal);
  expect(data(result.output).report).toBe("No stored summary is recoverable.");
  expect(result.output).not.toContain("message 4");
});

describe("parent subagent tool boundary", () => {
  it.each(SUBAGENT_TOOL_NAMES.filter((name) => name !== "subagent.read" && name !== "subagent.list"))("rejects %s when orchestration is disabled", async (name) => {
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

  it("continues a child without follow-up arguments for backward compatibility", async () => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.restart", args: { id: run.id } }, context, signal);
    expect(result.ok).toBe(true);
    expect(manager.restart).toHaveBeenCalledExactlyOnceWith(run.id);
  });

  it.each([
    { prompt: "Inspect the caller" },
    { context: "The route has changed" },
    { prompt: "Inspect the caller", context: "The route has changed" },
  ])("forwards focused restart instructions without changing the original route: %j", async (followup) => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.restart", args: { id: run.id, ...followup, cwd: "/", model: "other" } }, context, signal);
    expect(result.ok).toBe(true);
    expect(manager.restart).toHaveBeenCalledExactlyOnceWith(run.id, { prompt: followup.prompt, context: followup.context });
    expect(manager.start).not.toHaveBeenCalled();
  });

  it.each([
    { prompt: "" }, { prompt: 42 }, { prompt: "x".repeat(12001) },
    { context: " " }, { context: false }, { context: "x".repeat(24001) },
  ])("rejects invalid restart instructions before launching ($#)", async (followup) => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.restart", args: { id: run.id, ...followup } }, context, signal);
    expect(result.ok).toBe(false);
    expect(result.output).toContain("non-empty string");
    expect(manager.restart).not.toHaveBeenCalled();
  });

  it("advertises optional bounded follow-ups in both tool definition formats", () => {
    for (const definitions of [getToolDefinitions(), getCompactToolDefinitions()]) {
      const restart = definitions.find((definition) => definition.name === "subagent.restart")!;
      expect(restart.parameters).toMatchObject({
        required: ["id"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", minLength: 1, maxLength: 12000 },
          context: { type: "string", minLength: 1, maxLength: 24000 },
        },
      });
    }
    expect(orchestrationContext(true)).toContain("subagent.restart");
    expect(orchestrationContext(true)).toContain("follow-up");
  });

  it("exposes partial status and recovery with reports instead of promoting them to completed", async () => {
    const { manager, context, signal } = fixture();
    const partial: SubagentRun = { ...run, status: "partial", recovery: "exact", report: "Status: partial\nPrior evidence and coverage gaps" };
    manager.get.mockReturnValue(partial);
    manager.wait.mockResolvedValue(partial);
    const report = await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report" } }, context, signal);
    expect(data(report.output)).toMatchObject({ status: "partial", recovery: "exact", reportAvailable: true, report: partial.report });
    const waited = await runSubagentTool({ name: "subagent.wait", args: { id: run.id } }, context, signal);
    expect(data(waited.output)).toMatchObject({ status: "partial", recovery: "exact", reportAvailable: true });
    expect(data(waited.output).report).toBe(partial.report);
    expect(manager.wait).toHaveBeenCalledWith(run.id, undefined, signal);
    expect(manager.acknowledgeResult).toHaveBeenCalledWith(run.id, run.attempt);
  });

  it("joins the first available child without requiring an ID or a deadline", async () => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.wait", args: {} }, context, signal);
    expect(result.ok).toBe(true);
    expect(data(result.output)).toMatchObject({ id: run.id, report: run.report });
    expect(manager.waitAny).toHaveBeenCalledWith(undefined, undefined, signal);
    expect(manager.acknowledgeResult).toHaveBeenCalledWith(run.id, run.attempt);
    manager.waitAny.mockResolvedValue(undefined);
    expect(data((await runSubagentTool({ name: "subagent.wait", args: {} }, context, signal)).output).status).toBe("idle");
  });

  it("accepts explicit long joins without turning them into cancellation", async () => {
    const { manager, context, signal } = fixture();
    const result = await runSubagentTool({ name: "subagent.wait", args: { id: run.id, timeoutMs: 120000 } }, context, signal);
    expect(result.ok).toBe(true);
    expect(manager.wait).toHaveBeenCalledWith(run.id, 120000, signal);
    expect(manager.stop).not.toHaveBeenCalled();
  });

  it("does not acknowledge a timeout snapshot if the child settles before tool continuation", async () => {
    const { manager, context, signal } = fixture();
    manager.wait.mockImplementation(async () => ({ ...run, status: "running", report: undefined }));
    const result = await runSubagentTool({ name: "subagent.wait", args: { id: run.id, timeoutMs: 1 } }, context, signal);
    expect(data(result.output).status).toBe("running");
    expect(manager.acknowledgeResult).not.toHaveBeenCalled();
  });

  it("preserves a ready result if cancellation wins before join continuation", async () => {
    const { manager, context } = fixture();
    const controller = new AbortController();
    const waiting = runSubagentTool({ name: "subagent.wait", args: {} }, context, controller.signal);
    controller.abort();
    expect(await waiting).toMatchObject({ ok: false, exitCode: 130 });
    expect(manager.acknowledgeResult).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, 2147483648, "1000"])("rejects invalid wait timeout %s", async (timeoutMs) => {
    const { manager, context, signal } = fixture();
    expect((await runSubagentTool({ name: "subagent.wait", args: { timeoutMs } }, context, signal)).ok).toBe(false);
    expect(manager.waitAny).not.toHaveBeenCalled();
  });

  it("caps tail output even after its character budget is exhausted", async () => {
    const { manager, context, signal } = fixture();
    manager.get.mockReturnValue({ ...run, events: run.events.map((event) => ({ ...event, text: "x".repeat(13000) })) });
    const result = await runSubagentTool({ name: "subagent.read", args: { id: run.id, limit: 4 } }, context, signal);
    expect(data(result.output).events.reduce((n: number, event: { text: string }) => n + event.text.length, 0)).toBe(12000);
  });

  it("paginates long reports without losing the remaining evidence", async () => {
    const { manager, context, signal } = fixture();
    const report = "A".repeat(24000) + "Decisive evidence at src/worker.ts:42";
    manager.get.mockReturnValue({ ...run, report });
    const first = data((await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report" } }, context, signal)).output);
    expect(first).toMatchObject({ reportLength: report.length, reportOffset: 0, nextOffset: 24000 });
    expect(first.report).toHaveLength(24000);
    const last = data((await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report", offset: first.nextOffset } }, context, signal)).output);
    expect(last.nextOffset).toBeUndefined();
    expect(first.report + last.report).toBe(report);
  });

  it("reads delivered report pages from their original attempt after restart", async () => {
    const report = "A".repeat(24000) + "Original final evidence";
    const manager = new SubagentManager("pagination", { worker: async ({ run }) => run.attempt === 1 ? report : "Different follow-up report" });
    const context = { manager, provider: "openai" as const, model: "test", cwd: process.cwd() };
    const signal = new AbortController().signal;
    try {
      manager.setEnabled(true);
      const child = manager.start({ ...run, prompt: "Inspect original evidence" });
      await manager.wait(child.id);
      manager.restart(child.id);
      const first = data((await runSubagentTool({ name: "subagent.wait", args: {} }, context, signal)).output);
      expect(first).toMatchObject({ attempt: 1, nextOffset: 24000 });
      await manager.wait(child.id);
      const last = data((await runSubagentTool({ name: "subagent.read", args: { id: child.id, attempt: first.attempt, view: "report", offset: first.nextOffset } }, context, signal)).output);
      expect(first.report + last.report).toBe(report);
      expect(last.attempt).toBe(1);
      expect(manager.pendingResults()).toEqual([expect.objectContaining({ attempt: 2 })]);
    } finally {
      manager.dispose();
    }
  });

  it.each([-1, 0.5, "0", Number.MAX_SAFE_INTEGER])("rejects invalid report offsets %s", async (offset) => {
    const { context, signal } = fixture();
    expect((await runSubagentTool({ name: "subagent.read", args: { id: run.id, view: "report", offset } }, context, signal)).ok).toBe(false);
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
