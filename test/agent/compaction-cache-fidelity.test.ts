import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { carriedUserInstructions, renderUserInstructions, USER_INSTRUCTION_UPDATES_HEADING } from "../../src/agent/context/compaction-user-instructions.js";
import { prepareCompactionCandidateMessages } from "../../src/agent/turn/compaction-candidate.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../../src/llm/router.js", () => ({
  completeWithProvider: complete,
  streamWithProvider: vi.fn(),
}));

const { executeCompactionSummary, planCompactionReplay } = await import(
  "../../src/agent/compaction-executor.js"
);

function request(): CompletionRequest {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    messages: [
      { role: "system", content: "Stable rules" },
      {
        role: "system",
        content: "Session memory from compacted earlier turns:\n\nPrior research completed.",
        compaction: { recentUserPrompts: [{ content: "Explain the prior failure." }] },
      },
      {
        role: "user",
        content: "Inspect the screenshot",
        images: [{ mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
      },
      { role: "assistant", content: "The screenshot contains a failing test." },
      { role: "user", content: "Fix the test." },
    ],
    thinking: { enabled: true, effort: "high" },
    forceReasoningReplay: true,
    temperature: 0.7,
    tools: [{ name: "fs.read", description: "Read a file", parameters: { type: "object", properties: {} } }],
    toolChoice: "auto",
    parallelToolCalls: true,
  };
}

function blocks(body: { messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> }) {
  return body.messages.flatMap(({ role, content }) => {
    const parts = typeof content === "string" ? [{ type: "text", text: content }] : content;
    return parts.map(({ cache_control: _, ...block }) => ({ role, ...block }));
  });
}

beforeEach(() => {
  complete.mockReset().mockResolvedValue({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    text: "## Work\nThe failing test was inspected.\n## Remaining\nApply the fix.",
    finishReason: "stop",
  });
});

describe("compaction request cache fidelity", () => {
  it("keeps instructions, project files and a cache-identical request prefix over six single-request compactions", async () => {
    const rule = { id: "U1", scope: "session" as const, text: "Preserve public API compatibility." };
    const style = { id: "U2", scope: "session" as const, text: "Use descriptive test names." };
    const quote = "Allow breaking API changes only on the v2 branch.";
    const replacement = { ...rule, text: quote };
    const projectBlock = "PROJECT INSTRUCTIONS\n--- .clai/INSTRUCTIONS.md (this project) ---\n- Use the existing formatter.";
    const story = "ORIENTATION: The test review is complete.\n\n## Work completed\n- Inspected the failing test.\n\n## Remaining work\n- Apply the verified fix.";
    const generated = [
      `${renderUserInstructions([{ ...rule, text: "Keep APIs compatible." }, style])}\n\n${story}`,
      `${USER_INSTRUCTION_UPDATES_HEADING}\n- [U1] superseded; user: missing source quote\n\n${story}`,
      `${renderUserInstructions([replacement])}\n\n${USER_INSTRUCTION_UPDATES_HEADING}\n- [U1] superseded; user: ${JSON.stringify(quote)}\n\n${story}`,
      `${USER_INSTRUCTION_UPDATES_HEADING}\n- [U1] completed; evidence: "The test review is complete."\n\n${story}`,
      `${renderUserInstructions([{ ...rule, scope: "task" }])}\n\n${renderUserInstructions([style])}\n\n${story}`,
      story,
    ];
    let original = request();
    original.messages.splice(1, 1,
      { role: "system", content: projectBlock },
      { role: "system", content: `Session memory from compacted earlier turns:\n\n${renderUserInstructions([rule])}\n\n${story}`, compaction: { recentUserPrompts: [], userInstructions: [rule] } },
    );
    original.messages.at(-1)!.content += ` ${style.text}`;

    for (let round = 0; round < generated.length; round += 1) {
      if (round === 2) original.messages.at(-1)!.content = quote;
      complete.mockResolvedValueOnce({ provider: original.provider, model: original.model, text: generated[round], finishReason: "stop" });
      const snapshot = successfulRequestSnapshot("anthropic", original.model!, original);
      const history: ChatMessage[] = [...original.messages, { role: "assistant", content: "The test review is complete." }];
      const before = structuredClone(history);
      const result = await compactMessagesWithSummary(history, (prompt) => executeCompactionSummary({
        provider: "anthropic", model: original.model, systemContent: "Unused summary system",
        prompt, maxTokens: 12_288, baseRequest: snapshot, history, stream: false,
        qualityRetry: false, retryOnTruncation: false, retryOnRequestShapeRejection: false,
      }), { budgetTokens: 0, singleAdmission: true, forceDirectSinglePass: true });

      expect(complete).toHaveBeenCalledTimes(round + 1);
      expect(result.strategy).toBe("direct");
      expect(result.messages[0]).toEqual(original.messages[0]);
      expect(carriedUserInstructions(result.messages)).toEqual([round < 2 ? rule : replacement, style]);
      const memory = result.messages.find(isCompactionMemoryMessage)!;
      expect(memory.content).not.toContain(USER_INSTRUCTION_UPDATES_HEADING);
      expect(memory.content.match(/## User instructions still in force/g)).toHaveLength(1);
      expect(history).toEqual(before);

      const sent = complete.mock.calls[round]![0] as CompletionRequest;
      expect(sent.messages.slice(0, snapshot.messages.length)).toEqual(snapshot.messages);
      const priorWire = JSON.parse(buildAnthropicBody(original, false));
      const compactionWire = JSON.parse(buildAnthropicBody(sent, false));
      expect(compactionWire.system).toEqual(priorWire.system);
      expect(compactionWire.tools).toEqual(priorWire.tools);
      expect(compactionWire.thinking).toEqual(priorWire.thinking);
      expect(compactionWire.tool_choice).toEqual(priorWire.tool_choice);
      expect(blocks(compactionWire).slice(0, blocks(priorWire).length)).toEqual(blocks(priorWire));

      const candidate = prepareCompactionCandidateMessages({
        messages: result.messages,
        agentInstructionsBlock: projectBlock,
        activeSkillsBlock: undefined,
        livePlan: undefined,
        planApproved: false,
      });
      expect(candidate.filter((message) => message.content === projectBlock)).toHaveLength(1);
      original = { ...original, messages: JSON.parse(JSON.stringify([...candidate, { role: "user", content: `Review module ${round + 1}.` }])) };
    }
  });

  it("appends instruction continuity after an unchanged wire prefix and restores omitted rules without another request", async () => {
    const original = request();
    const rule = { id: "U1", scope: "session" as const, text: "Preserve backward compatibility unless the user approves an exception." };
    original.messages[1] = {
      ...original.messages[1]!,
      content: `${original.messages[1]!.content}\n\n${renderUserInstructions([rule])}`,
      compaction: { recentUserPrompts: [], userInstructions: [rule] },
    };
    const snapshot = successfulRequestSnapshot("anthropic", original.model!, original);
    const history: ChatMessage[] = [...original.messages, { role: "assistant", content: "The test review is complete." }];
    const before = structuredClone(history);
    const result = await compactMessagesWithSummary(history, (prompt) => executeCompactionSummary({
      provider: "anthropic", model: original.model, systemContent: "Unused summary system",
      prompt, maxTokens: 12_288, baseRequest: snapshot, history, stream: false,
      qualityRetry: false, retryOnTruncation: false, retryOnRequestShapeRejection: false,
    }), { budgetTokens: 0, singlePassInputBudgetTokens: 200_000 });

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0] as CompletionRequest;
    expect(sent.messages.slice(0, snapshot.messages.length)).toEqual(snapshot.messages);
    expect(sent.messages.at(-1)?.content).toContain(rule.text);
    expect(sent.messages.at(-1)?.content).toContain("carry forward at EVERY compaction");
    const priorWire = JSON.parse(buildAnthropicBody(original, false));
    const compactionWire = JSON.parse(buildAnthropicBody(sent, false));
    expect(compactionWire.system).toEqual(priorWire.system);
    expect(compactionWire.tools).toEqual(priorWire.tools);
    expect(compactionWire.thinking).toEqual(priorWire.thinking);
    expect(blocks(compactionWire).slice(0, blocks(priorWire).length)).toEqual(blocks(priorWire));
    expect(carriedUserInstructions(result.messages)).toEqual([rule]);
    expect(history).toEqual(before);
  });

  it("preserves image blocks and generation settings through the serialized replay prefix", async () => {
    const original = request();
    const snapshot = successfulRequestSnapshot("anthropic", "claude-sonnet-4-5", original);
    const history: ChatMessage[] = [
      ...original.messages,
      { role: "assistant", content: "I located the cause." },
    ];
    const plan = planCompactionReplay({
      baseRequest: snapshot,
      history,
      prompt: "Summarize the session.",
      maxTokens: 12_288,
      contextLimitTokens: 200_000,
    });
    expect(plan?.messages.slice(0, snapshot.messages.length)).toEqual(snapshot.messages);

    await executeCompactionSummary({
      provider: "openai",
      model: "other-model",
      systemContent: "Unused summary system",
      prompt: "Summarize the session.",
      maxTokens: 12_288,
      baseRequest: snapshot,
      history,
      stream: false,
      qualityRetry: false,
      retryOnTruncation: false,
      retryOnRequestShapeRejection: false,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0] as CompletionRequest;
    expect(sent.forceReasoningReplay).toBe(true);
    expect(sent.thinking).toEqual(original.thinking);
    expect(sent.provider).toBe(original.provider);
    expect(sent.model).toBe(original.model);
    expect(sent.messages).toEqual(plan?.messages);
    const before = JSON.parse(buildAnthropicBody(original, false));
    const after = JSON.parse(buildAnthropicBody(sent, false));
    expect(after.tools).toEqual(before.tools);
    expect(after.system).toEqual(before.system);
    expect(after.thinking).toEqual(before.thinking);
    expect(after.tool_choice).toEqual(before.tool_choice);
    expect(blocks(after).slice(0, blocks(before).length)).toEqual(blocks(before));
    expect(original).toEqual(request());
  });

  it("retains the last successful route and controls when full replay is unavailable", async () => {
    const original = request();
    const snapshot = successfulRequestSnapshot("anthropic", "claude-sonnet-4-5", original);
    const sourceMessages = original.messages.slice(0, 3);

    await executeCompactionSummary({
      provider: "openai",
      model: "other-model",
      systemContent: "Summarize",
      prompt: "Summarize only this prefix.",
      maxTokens: 12_288,
      requestSettings: snapshot,
      sourceMessages,
      stream: false,
      qualityRetry: false,
      retryOnTruncation: false,
      retryOnRequestShapeRejection: false,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0] as CompletionRequest;
    expect(sent).toMatchObject({
      provider: snapshot.provider,
      model: snapshot.model,
      temperature: snapshot.temperature,
      thinking: snapshot.thinking,
      forceReasoningReplay: true,
      tools: snapshot.tools,
      toolChoice: snapshot.toolChoice,
      parallelToolCalls: snapshot.parallelToolCalls,
    });
    expect(sent.messages.slice(0, sourceMessages.length)).toEqual(sourceMessages);
  });

  it.each([
    ["reasoning-only", () => ({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      text: "",
      reasoningBlock: { text: "I should summarize the retained state." },
    })],
    ["empty-error", () => {
      throw new Error("Kiro completed without a visible answer.");
    }],
  ])("keeps cache-identical controls first and lowers reasoning only for a %s retry", async (_label, firstAttempt) => {
    const original = request();
    const snapshot = successfulRequestSnapshot("anthropic", "claude-sonnet-4-5", original);
    complete
      .mockReset()
      .mockImplementationOnce(async () => firstAttempt())
      .mockResolvedValueOnce({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        text: [
          "## User goals",
          "Continue the current implementation safely.",
          "## Work completed",
          "The relevant provider behavior was diagnosed.",
          "## Current state",
          "The original transcript remains retained.",
          "## Remaining work",
          "Run the focused regression suite.",
        ].join("\n"),
      });

    const summary = await executeCompactionSummary({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      systemContent: "Summarize",
      prompt: "Summarize the current session.",
      maxTokens: 12_288,
      requestSettings: snapshot,
      sourceMessages: original.messages.slice(0, 3),
      stream: false,
      qualityRetry: true,
      retryDelayMs: 0,
      retryOnTruncation: false,
      retryOnRequestShapeRejection: false,
    });

    expect(summary).toContain("## Current state");
    expect(complete).toHaveBeenCalledTimes(2);
    const [first, retry] = complete.mock.calls.map(
      ([sent]) => sent as CompletionRequest,
    );
    expect(first!.thinking).toEqual(snapshot.thinking);
    expect(first!.temperature).toBe(snapshot.temperature);
    expect(retry!.thinking).toEqual({ enabled: false, effort: "low" });
  });
});
