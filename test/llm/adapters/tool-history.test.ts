import { afterEach, describe, expect, it } from "vitest";

import { toAnthropicToolMessages } from "../../../src/llm/adapters/anthropic-tools.js";
import { toOpenAiToolMessages } from "../../../src/llm/adapters/openai-tools.js";
import { invalidNativeToolHistoryIndexes } from "../../../src/llm/adapters/tool-history.js";
import { toOpenAiMessages } from "../../../src/llm/wire/chat-body.js";
import { chatCompletionsBodyFromPlan } from "../../../src/llm/wire/chat-body.js";
import { compileRequestPlan } from "../../../src/llm/request-plan.js";
import { clearTextOnlyModels, markTextOnlyModel } from "../../../src/llm/tool-protocol.js";
import type { ChatMessage } from "../../../src/types.js";

const incompleteHistory: ChatMessage[] = [
  { role: "user", content: "inspect the workspace" },
  {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "a.txt" } }],
  },
  { role: "user", content: "continue after the provider error" },
];

afterEach(() => clearTextOnlyModels());

describe("tool history portability", () => {
  it("marks an uncompleted native tool transaction as non-native", () => {
    expect([...invalidNativeToolHistoryIndexes(incompleteHistory)]).toEqual([1]);
  });

  it("keeps completed native tool transactions", () => {
    const complete = [
      ...incompleteHistory.slice(0, 2),
      { role: "tool" as const, toolCallId: "call_1", name: "fs.read", content: "done" },
      incompleteHistory[2]!,
    ];
    expect([...invalidNativeToolHistoryIndexes(complete)]).toEqual([]);
  });

  it("marks a tool result with an unmatched id as non-native", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "go" },
      { role: "tool", toolCallId: "orphan_1", name: "fs.read", content: "output" },
    ];
    expect([...invalidNativeToolHistoryIndexes(history)]).toEqual([1]);
  });

  it("marks partial parallel results and a final uncompleted call as non-native", () => {
    const partial: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_1", name: "fs.read", args: {} },
          { id: "call_2", name: "fs.list", args: {} },
        ],
      },
      { role: "tool", toolCallId: "call_1", name: "fs.read", content: "output" },
      { role: "user", content: "continue" },
    ];
    const atEof = partial.slice(0, 2);
    expect([...invalidNativeToolHistoryIndexes(partial)]).toEqual([1, 2]);
    expect([...invalidNativeToolHistoryIndexes(atEof)]).toEqual([1]);
  });

  it("projects unfinished calls into portable OpenAI-compatible history", () => {
    const messages = toOpenAiToolMessages(incompleteHistory, (message) => message.content);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: '[Tool call: fs_read]\n{"path":"a.txt"}',
    });
  });

  it("projects unfinished calls into portable Anthropic history", () => {
    const messages = toAnthropicToolMessages(incompleteHistory);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: '[Tool call: fs_read]\n{"path":"a.txt"}',
    });
  });

  it("retains portable transaction selection after stripping images", () => {
    const call = incompleteHistory[1]!;
    const result: ChatMessage = {
      role: "tool",
      toolCallId: "call_1",
      name: "fs.read",
      content: "image result",
      images: [{ mediaType: "image/png", dataBase64: "AA==" }],
    };
    const wire = toOpenAiMessages(
      [incompleteHistory[0]!, call, result, incompleteHistory[2]!],
      false,
      {
        target: { provider: "tokenrouter", model: "test", dialect: "openai-compatible" },
        portableToolHistory: new Set([call, result]),
      },
    );
    expect(wire[2]).toMatchObject({ role: "user" });
    expect(wire[2]!["content"] as string).toContain(
      "[Tool result: fs_read]\nimage result",
    );
  });

  it("projects completed history for a learned text-only route", () => {
    const provider = "tokenrouter";
    const model = "deepseek/deepseek-v4-pro";
    markTextOnlyModel(provider, model);
    const messages: ChatMessage[] = [
      incompleteHistory[0]!,
      incompleteHistory[1]!,
      { role: "tool", toolCallId: "call_1", name: "fs.read", content: "done" },
      incompleteHistory[2]!,
    ];
    const plan = compileRequestPlan({ provider, model, messages, stream: true });
    const wire = JSON.parse(chatCompletionsBodyFromPlan(plan)) as {
      messages: Array<Record<string, unknown>>;
    };
    expect(wire.messages.some((message) => message["tool_calls"] !== undefined)).toBe(false);
    expect(wire.messages.some((message) => message["role"] === "tool")).toBe(false);
  });
});
