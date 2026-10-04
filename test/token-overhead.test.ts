import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getCompactToolDefinitions, getToolDefinitions } from "../src/tools/definitions.js";
import { agentModeDirective, planModeDirective, renderAgentSystemPrompt, renderCompactAgentSystemPrompt } from "../src/prompts/index.js";
import { createToolRouting } from "../src/agent/turn/tool-routing.js";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { toOpenAiTools } from "../src/llm/adapters/openai-tools.js";
import { compileRequestPlan } from "../src/llm/request-plan.js";
import type { ChatMessage } from "../src/types.js";
import { COMPACTION_SYSTEM_PROMPT, buildCompactionUserPrompt } from "../src/agent/compaction-summary.js";
import { createPlan } from "../src/store/plan.js";
import { planContextMessage } from "../src/agent/plan-tool.js";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

describe("token overhead contracts", () => {
  it("locks the retained tool catalog, arguments, flags and validation constraints", () => {
    expect(sha256(JSON.stringify(getToolDefinitions())))
      .toBe("d672b0dcaf89883b6a0f67213eced3697ef496958e4d98b1a7835d2e156d9f39");
  });

  it("keeps the complete catalog when compact mode is requested", () => {
    expect(getCompactToolDefinitions()).toEqual(getToolDefinitions());
    expect(getToolDefinitions({ compact: true, askMode: true })).toEqual(getToolDefinitions({ askMode: true }));
  });

  it("keeps default native instruction and tool overhead below 22k estimated tokens", () => {
    const route = createToolRouting({
      mode: "agent", mcpPresent: false,
      toolCalling: "native", useCompactSystemPrompt: () => false,
    });
    const system = route.buildStableSystemContent(true, "nvidia", "openai/gpt-oss-20b");
    const tools = route.selectToolDefs(true, false, "nvidia", "openai/gpt-oss-20b")!;
    expect(Math.ceil((system.length + JSON.stringify(toOpenAiTools(tools)).length) / 3.3)).toBeLessThan(22_000);
    expect(system).not.toContain("Available tool names:");
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(route.routeToolNames("nvidia", "openai/gpt-oss-20b")));
    expect(system).toContain("both the exact current oldText and intended newText");
    expect(system).toContain("do not repeat the same oldText");
  });

  it("documents every permitted tool on text-only routes", () => {
    const tools = getToolDefinitions();
    const names = tools.map((tool) => tool.name).join(", ");
    const full = renderAgentSystemPrompt(names, { stableEnvironment: true });
    const compact = renderCompactAgentSystemPrompt(names, { stableEnvironment: true });
    expect(renderCompactAgentSystemPrompt(names, { stableEnvironment: true })).toBe(compact);
    for (const tool of tools) {
      expect(full).toContain(tool.name);
      expect(compact).toContain(tool.name);
    }
    expect(full).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(full).toContain('fs.edit: {"path":"<file>","oldText":"<exact>","newText":"<replacement>"');
    expect(full).toContain("rg -n --glob");
  });

  it("keeps the complete tool list visible when visual inspection is unavailable", () => {
    const names = getToolDefinitions().map((tool) => tool.name).join(", ");
    for (const render of [renderAgentSystemPrompt, renderCompactAgentSystemPrompt]) {
      const prompt = render(names, { imageView: false });
      const list = prompt.split("\n").find((line) => line.startsWith("Available tools:"))!;
      for (const tool of getToolDefinitions().filter((tool) => tool.name !== "image.view")) {
        expect(list).toContain(tool.name);
      }
      expect(list).not.toContain("image.view");
    }
  });

  it("preserves full plan-mode and compaction requirements with current inspection guidance", () => {
    expect(sha256(planModeDirective())).toBe("f04a12a631b001920c96899cae3b013a7ac8ef9a60ee72c937b5782ba7371d5e");
    expect(sha256(COMPACTION_SYSTEM_PROMPT)).toBe("717b5312b02d2ad9221be8e222a6b9c1b09e84072ed82e3de22ff8f0ed9b41c6");
    expect(sha256(buildCompactionUserPrompt({
      messageTranscript: "User asked to fix retry count. Read /project/state.mjs: retryLimit=2. fs.edit changed retryLimit to 3. node check.mjs exited 0.",
      durableState: "ACTIVE PLAN: t1 done; t2 pending: set backoffMs=100 without changing CRLF.",
    }))).toBe("20a375f28a237852a4476e1bb8ba713db8f3186e1e1c6871e32b3faf598994bc");
    expect(sha256(buildCompactionUserPrompt({
      messageTranscript: "Read /project/package.json: Vite installed. Existing source has a mock payment form. Verified webhook route requires signature validation.",
      durableState: "ACTIVE PLAN: Implement signature validation; verify invalid signatures and replay protection.",
      purpose: "plan-implement",
    }))).toBe("48e73ee6344d7f3e89e874cfc587aea479339eb57228d31f03c8e46f573df56f");
  });

  it("injects full plan detail and acceptance criteria even with a small request-context budget", () => {
    const plan = createPlan({
      sessionId: "token-contract", goal: "Preserve payment contracts", kind: "coding",
      detail: "Validate signatures, reject replay, preserve all request fields.\n".repeat(160),
      taskTitles: ["Implement webhook validation", "Verify integration and invalid signatures"],
    });
    plan.status = "approved";
    plan.tasks[0]!.acceptanceCriteria = "Reject invalid signatures with 401; accept valid signed fixtures. ".repeat(80);
    const memory: ChatMessage = { role: "system", content: "CONTINUATION MEMORY\nstate.mjs uses CRLF; retryLimit=3 verified; backoffMs=100 remains pending." };
    const { messages } = composeTurnMessages({
      prompt: "Implement the accepted plan", displayPrompt: undefined, images: undefined,
      history: [memory], mode: "agent", systemSections: [planModeDirective()],
      selectedSkillNames: [], nativeToolsActive: true, inputTokenBudget: 5_000,
      stableSystemContent: () => "Stable instructions", instructionsBlock: undefined,
      skillsBlock: undefined, plan, planApproved: true,
    });
    expect(messages[1]).toEqual(memory);
    expect(messages).toContainEqual({ role: "system", content: planContextMessage(plan, true) });
    expect(messages.some((message) => message.content.includes(plan.detail))).toBe(true);
    expect(messages.some((message) => message.content.includes(plan.tasks[0]!.acceptanceCriteria!.trim()))).toBe(true);
  });

  it("retains the user task once and anchors it independently of internal notices", () => {
    const prompt = "Change the export retry policy to four attempts, preserving its backoff.";
    const { messages } = composeTurnMessages({
      prompt, displayPrompt: undefined, images: undefined, history: undefined,
      mode: "agent", systemSections: [], selectedSkillNames: [], nativeToolsActive: true,
      inputTokenBudget: undefined, stableSystemContent: () => "Stable instructions",
      instructionsBlock: undefined, skillsBlock: undefined, plan: undefined, planApproved: false,
    });
    const serialized = JSON.stringify(messages);
    expect(serialized.split(prompt)).toHaveLength(2);
    expect(serialized).toContain("internal/system notices are context, not new user tasks");
  });

  it("keeps the instructions and schema fingerprint through budget changes and appended recovery/delivery", () => {
    let compact = false;
    const route = createToolRouting({
      mode: "agent", mcpPresent: true,
      toolCalling: "native", useCompactSystemPrompt: () => compact,
    });
    const messages: ChatMessage[] = [
      { role: "system", content: route.buildStableSystemContent(true, "nvidia", "test-model") },
      { role: "user", content: "previous task" },
      { role: "assistant", content: "previous result" },
      { role: "user", content: "current task" },
    ];
    const request = () => compileRequestPlan({
      provider: "nvidia", model: "test-model", messages, stream: true,
      tools: route.selectToolDefs(true, compact, "nvidia", "test-model"),
    });
    const initial = request();
    for (const content of ["recover an incomplete response", "delivered responder receipt", "resume the current task"]) {
      compact = !compact;
      messages.push({ role: "system", content });
      const next = request();
      expect(next.cache.fingerprint.prefixSha256).toBe(initial.cache.fingerprint.prefixSha256);
      expect(next.tools.definitions).toEqual(initial.tools.definitions);
      expect(route.buildStableSystemContent(true, "nvidia", "test-model")).toBe(messages[0]!.content);
    }
  });
});
