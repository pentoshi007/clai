import { describe, expect, it } from "vitest";
import { DEFAULT_SAMPLING, resolveSampling, samplingDefaults } from "../src/llm/sampling.js";
import { buildChatBody } from "../src/llm/http.js";
import type { ChatMessage } from "../src/types.js";

const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

describe("LLM-010 — declarative sampling policy", () => {
  const cases: Array<{
    model: string;
    reasoning?: boolean;
    expected: { temperature: number; topP?: number };
  }> = [
    { model: "minimax-m3", expected: { temperature: 1.0, topP: 0.95 } },
    { model: "minimaxai/minimax-m3", expected: { temperature: 1.0, topP: 0.95 } },
    { model: "openai/gpt-oss-120b", expected: { temperature: 1.0 } },
    { model: "qwen/qwen3-32b", reasoning: true, expected: { temperature: 0.6, topP: 0.95 } },
    // Without thinking, Qwen3 stays on the conservative default.
    { model: "qwen/qwen3-32b", expected: DEFAULT_SAMPLING },
    { model: "deepseek-ai/deepseek-r1", reasoning: true, expected: { temperature: 0.6, topP: 0.95 } },
    { model: "claude-opus-4-6", expected: DEFAULT_SAMPLING },
    { model: "llama-3.3-70b-versatile", expected: DEFAULT_SAMPLING },
  ];

  for (const testCase of cases) {
    it(`${testCase.model}${testCase.reasoning ? " (thinking)" : ""}`, () => {
      expect(
        samplingDefaults({
          model: testCase.model,
          reasoningEnabled: testCase.reasoning,
        }),
      ).toEqual(testCase.expected);
    });
  }

  it("an explicit temperature always wins", () => {
    expect(
      resolveSampling({ model: "minimax-m3", requestedTemperature: 0.1 }),
    ).toEqual({ temperature: 0.1, topP: 0.95 });
  });
});

describe("sampling reaches the OpenAI-compatible body", () => {
  it("sends the policy temperature and top_p", () => {
    const body = JSON.parse(
      buildChatBody({ model: "minimax-m3", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body.temperature).toBe(1.0);
    expect(body.top_p).toBe(0.95);
  });

  it("omits top_p when the policy has none", () => {
    const body = JSON.parse(
      buildChatBody({ model: "llama-3.3-70b-versatile", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body).not.toHaveProperty("top_p");
  });

  it("still omits sampling entirely for OpenAI reasoning models", () => {
    const body = JSON.parse(
      buildChatBody({ model: "gpt-5.1", messages, stream: false }),
    ) as Record<string, unknown>;
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });
});

describe("Chat Completions body system-message placement", () => {
  it("hoists the first system message and demotes later ones to marked user turns", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "qwen/qwen3.8-max-free",
        messages: [
          { role: "system", content: "base prompt" },
          { role: "user", content: "hello" },
          { role: "system", content: "REQUEST CONTEXT\nlive turn" },
          { role: "user", content: "next" },
        ],
        stream: false,
      }),
    ) as { messages: Array<{ role: string; content: string }> };
    const roles = body.messages.map((message) => message.role);
    expect(roles[0]).toBe("system");
    expect(roles.slice(1)).not.toContain("system");
    expect(body.messages[0]!.content).toBe("base prompt");
    const marked = body.messages.find(
      (message) => message.role === "user" && message.content.includes("REQUEST CONTEXT"),
    );
    expect(marked?.content.startsWith("[SYSTEM]")).toBe(true);
  });

  it("passes through requests with no system message unchanged", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "qwen/qwen3.8-max-free",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
        stream: false,
      }),
    ) as { messages: Array<{ role: string }> };
    expect(body.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
