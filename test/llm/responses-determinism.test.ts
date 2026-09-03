import { describe, expect, it } from "vitest";
import {
  buildResponsesBody,
  fallbackToolCallId,
} from "../../src/llm/responses-request.js";
import type { ChatMessage } from "../../src/types.js";

const config = {
  baseUrl: "https://wire.test",
  providerId: "openai",
  displayName: "t",
  artifactDialect: "openai-compatible",
  terminalPolicy: { proofs: ["response-completed"], naturalEofAccepted: false },
  buildHeaders: () => ({}),
  reasoningPayload: () => undefined,
  bodyExtras: () => ({}),
} as never;

const messages: ChatMessage[] = [
  { role: "system", content: "SYSTEM CONSTITUTION\nstable rules" },
  { role: "user", content: "do the thing" },
  {
    role: "assistant",
    content: "running",
    toolCalls: [{ id: "call_1", name: "fs.list", args: { path: "/tmp" } }],
  },
  { role: "tool", content: "Tool fs.list result (exit=0, ok=true):\nok", toolCallId: "call_1", name: "fs.list", ok: true },
];

describe("responses wire determinism", () => {
  it("derives a stable call id for tool outputs without one", () => {
    const message: ChatMessage = { role: "tool", content: "some output" };
    expect(fallbackToolCallId(message)).toBe(fallbackToolCallId(message));
    expect(fallbackToolCallId({ role: "tool", content: "other" })).not.toBe(
      fallbackToolCallId(message),
    );
  });

  it("serializes identical timelines to identical bytes", () => {
    const idless: ChatMessage[] = [
      ...messages,
      { role: "tool", content: "text-protocol result without an id" },
    ];
    const first = buildResponsesBody(config, {
      model: "gpt-4o-mini",
      messages: idless,
      stream: true,
      tools: [],
    });
    const second = buildResponsesBody(config, {
      model: "gpt-4o-mini",
      messages: idless,
      stream: true,
      tools: [],
    });
    expect(second).toBe(first);
    const body = JSON.parse(first) as {
      input: Array<{ type: string; call_id?: string }>;
    };
    const outputs = body.input.filter((item) => item.type === "function_call_output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.call_id).toBe("call_1");
    expect(outputs[1]!.call_id).toMatch(/^call_[0-9a-f]{16}$/);
  });
});
