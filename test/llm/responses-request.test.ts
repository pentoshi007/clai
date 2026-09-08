import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/types.js";
import type { ResponsesDialectConfig } from "../../src/llm/responses-config.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import {
  assistantMessageId,
  buildResponsesBody,
} from "../../src/llm/responses-request.js";

const config: ResponsesDialectConfig = {
  baseUrl: "https://gateway.test/v1",
  providerId: "explabs",
  displayName: "Test Gateway",
  artifactDialect: "openai-compatible",
  terminalPolicy: META_STREAM_TERMINAL,
  buildHeaders: () => ({}),
  reasoningPayload: () => undefined,
  bodyExtras: () => ({}),
};

function body(input: {
  messages: ChatMessage[];
  stream?: boolean;
}): Record<string, unknown> {
  return JSON.parse(
    buildResponsesBody(config, {
      model: "deepseek-v4-flash",
      messages: input.messages,
      stream: input.stream ?? true,
      maxTokens: 64,
    }),
  ) as Record<string, unknown>;
}

function assistantItems(parsed: Record<string, unknown>) {
  return (parsed.input as Array<Record<string, unknown>>).filter(
    (item) => item.role === "assistant" || item.type === "function_call",
  );
}

describe("assistantMessageId", () => {
  it("is stable across calls for identical messages", () => {
    const message: ChatMessage = { role: "assistant", content: "same answer" };
    expect(assistantMessageId(message)).toBe(assistantMessageId(message));
  });

  it("uses the msg_ prefix with a 16-hex-char digest", () => {
    expect(assistantMessageId({ role: "assistant", content: "hi" })).toMatch(
      /^msg_[0-9a-f]{16}$/,
    );
  });

  it("differs when content or tool calls differ", () => {
    const base: ChatMessage = { role: "assistant", content: "answer" };
    const withTools: ChatMessage = {
      role: "assistant",
      content: "answer",
      toolCalls: [{ id: "call_a", name: "fs_read", args: { path: "/x" } }],
    };
    const withOtherTool: ChatMessage = {
      role: "assistant",
      content: "answer",
      toolCalls: [{ id: "call_b", name: "fs_read", args: { path: "/x" } }],
    };
    const ids = new Set([
      assistantMessageId(base),
      assistantMessageId(withTools),
      assistantMessageId(withOtherTool),
    ]);
    expect(ids.size).toBe(3);
  });
});

describe("buildResponsesBody assistant output identity", () => {
  it("emits assistant history as a message item with a stable id and plain string content", () => {
    const history: ChatMessage[] = [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
      { role: "user", content: "and now?" },
    ];
    const parsed = body({ messages: history });
    const items = assistantItems(parsed);
    expect(items).toEqual([
      {
        type: "message",
        id: assistantMessageId(history[2]),
        role: "assistant",
        content: "hello there",
      },
    ]);
  });

  it("keeps system, user, and tool output items unchanged", () => {
    const parsed = body({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "q" },
        {
          role: "tool",
          toolCallId: "call_1",
          content: "tool result",
          name: "fs_read",
        },
      ],
    });
    const input = parsed.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "system",
      content: [{ type: "input_text", text: "sys" }],
    });
    expect(input[1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "q" }],
    });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "tool result",
    });
  });

  it("emits a tool turn as an identified assistant message plus function_call items", () => {
    const assistantTurn: ChatMessage = {
      role: "assistant",
      content: "let me check",
      toolCalls: [
        { id: "call_9", name: "fs_read", args: { path: "/tmp/x" } },
      ],
    };
    const parsed = body({
      messages: [
        { role: "user", content: "read the file" },
        assistantTurn,
        { role: "tool", toolCallId: "call_9", content: "contents" },
      ],
    });
    const items = assistantItems(parsed);
    expect(items).toEqual([
      {
        type: "message",
        id: assistantMessageId(assistantTurn),
        role: "assistant",
        content: "let me check",
      },
      {
        type: "function_call",
        call_id: "call_9",
        name: "fs_read",
        arguments: JSON.stringify({ path: "/tmp/x" }),
      },
    ]);
  });

  it("omits the assistant message item when a tool turn has no text content", () => {
    const parsed = body({
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call_2", name: "fs_list", args: { path: "/t" } }],
        },
      ],
    });
    expect(assistantItems(parsed)).toEqual([
      {
        type: "function_call",
        call_id: "call_2",
        name: "fs_list",
        arguments: JSON.stringify({ path: "/t" }),
      },
    ]);
  });

  it("never serializes the legacy phase or output_text input markers", () => {
    const serialized = buildResponsesBody(config, {
      model: "deepseek-v4-flash-vision-exp",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "first assistant answer" },
        { role: "user", content: "second" },
      ],
      stream: true,
      maxTokens: 64,
    });
    expect(serialized).not.toContain("output_text");
    expect(serialized).not.toContain('"phase"');
    expect(serialized).not.toContain("commentary");
  });

  it("emits the default temperature unless the dialect config omits sampling", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const withSampling = JSON.parse(
      buildResponsesBody(config, {
        model: "gateway-test-model",
        messages,
        stream: true,
        maxTokens: 64,
        temperature: 0.5,
      }),
    ) as Record<string, unknown>;
    expect(withSampling.temperature).toBe(0.5);

    const withoutSampling = JSON.parse(
      buildResponsesBody({ ...config, omitSampling: true }, {
        model: "gateway-test-model",
        messages,
        stream: true,
        maxTokens: 64,
        temperature: 0.5,
      }),
    ) as Record<string, unknown>;
    expect(withoutSampling.temperature).toBeUndefined();
    expect("top_p" in withoutSampling).toBe(false);
  });
});
