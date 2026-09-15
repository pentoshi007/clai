import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";

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
});
