import { describe, expect, it } from "vitest";
import {
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
} from "../src/llm/adapters/anthropic-tools.js";
import { buildAnthropicBody } from "../src/llm/anthropic.js";
import { appendAssistantWithTools } from "../src/agent/tool-history.js";
import type { ChatMessage } from "../src/types.js";

/**
 * LLM-006: Anthropic requires the signed thinking block on the assistant turn
 * that carries tool_use while extended thinking is enabled. It was never
 * captured from the stream and never replayed.
 */

describe("capturing signed thinking", () => {
  it("collects thinking text and signature_delta from the stream", () => {
    const state = createAnthropicToolStreamState();
    handleAnthropicStreamEvent(state, {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking" },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "I should read the file." },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-part-1" },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-part-2" },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "fs_read" },
    });
    handleAnthropicStreamEvent(state, {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
    });

    const finalized = finalizeAnthropicToolStream(state);
    expect(finalized.thinkingText).toBe("I should read the file.");
    expect(finalized.thinkingSignature).toBe("sig-part-1sig-part-2");
    expect(finalized.toolCalls[0]!.name).toBe("fs.read");
  });

  it("collects the signature from a non-stream response", () => {
    const parsed = parseAnthropicToolUseBlocks([
      { type: "thinking", thinking: "plan first", signature: "sig-abc" },
      { type: "tool_use", id: "toolu_1", name: "fs_read", input: { path: "a" } },
    ]);
    expect(parsed.thinkingSignature).toBe("sig-abc");
    expect(parsed.thinkingText).toBe("plan first");
  });
});

describe("replaying signed thinking", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "constitution" },
    { role: "user", content: "read a.txt" },
    {
      role: "assistant",
      content: "reading it",
      toolCalls: [{ id: "toolu_1", name: "fs.read", args: { path: "a.txt" } }],
      reasoningBlock: { text: "I should read the file.", signature: "sig-abc" },
    },
    { role: "tool", content: "ok=true", toolCallId: "toolu_1", name: "fs.read", ok: true },
    { role: "user", content: "thanks" },
  ];

  it("emits the thinking block first on the tool_use turn", () => {
    const messages = toAnthropicToolMessages(history, {
      target: {
        provider: "anthropic",
        model: "test-claude",
        dialect: "anthropic-messages",
      },
    });
    const assistant = messages.find((m) => m.role === "assistant")!;
    const blocks = assistant.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({
      type: "thinking",
      thinking: "I should read the file.",
      signature: "sig-abc",
    });
    expect(blocks.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("round trips through the request body", () => {
    const body = buildAnthropicBody(
      { messages: history, thinking: { enabled: true, effort: "medium" } },
      false,
    );
    expect(body).toContain("sig-abc");
    expect(body).toContain('"type":"thinking"');
  });

  it("omits the block when no signature was captured", () => {
    const messages = toAnthropicToolMessages([
      {
        role: "assistant",
        content: "x",
        toolCalls: [{ id: "t1", name: "fs.read", args: {} }],
        reasoningBlock: { text: "unsigned" },
      },
    ]);
    const blocks = messages[0]!.content as Array<Record<string, unknown>>;
    expect(blocks.some((b) => b.type === "thinking")).toBe(false);
  });
});

describe("history append keeps the signed block", () => {
  it("stores reasoningBlock on the assistant turn", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(
      messages,
      "working",
      [{ id: "t1", name: "fs.read", args: { path: "a" } }],
      { text: "thought", signature: "sig-1" },
    );
    expect(messages[0]!.reasoningBlock).toEqual({
      text: "thought",
      signature: "sig-1",
    });
  });

  it("stores an unsigned reasoning block so non-Anthropic models can replay reasoning_content", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "working", [
      { id: "t1", name: "fs.read", args: {} },
    ], { text: "thought" });
    expect(messages[0]!.reasoningBlock).toEqual({ text: "thought" });
  });
});
