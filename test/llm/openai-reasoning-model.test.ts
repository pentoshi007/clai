import { describe, expect, it } from "vitest";
import { buildChatBody, isOpenAiReasoningModel } from "../../src/llm/http.js";

/**
 * OpenAI's reasoning model families (gpt-5.x, o1/o3/o4) reject the legacy
 * Chat Completions sampling params: `max_tokens` must be
 * `max_completion_tokens`, and `temperature` must be omitted (only the
 * default value 1 is accepted). Sending either the old way returns HTTP 400
 * "Unsupported parameter". This must apply to every OpenAI-compatible
 * provider that can route to a real gpt-5.x/o-series model id.
 */
describe("isOpenAiReasoningModel", () => {
  it("matches gpt-5.x variants", () => {
    expect(isOpenAiReasoningModel("gpt-5.6-terra")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5-mini")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-5.4-pro")).toBe(true);
  });

  it("matches gpt-6 variants", () => {
    expect(isOpenAiReasoningModel("gpt-6-astra")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-6")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-6.1")).toBe(true);
    expect(isOpenAiReasoningModel("gpt-6-mini")).toBe(true);
  });

  it("matches o1/o3/o4 series", () => {
    expect(isOpenAiReasoningModel("o1")).toBe(true);
    expect(isOpenAiReasoningModel("o3-mini")).toBe(true);
    expect(isOpenAiReasoningModel("o4-mini")).toBe(true);
  });

  it("does not match unrelated models", () => {
    expect(isOpenAiReasoningModel("gpt-4o-mini")).toBe(false);
    expect(isOpenAiReasoningModel("gpt-oss-20b")).toBe(false);
    expect(isOpenAiReasoningModel("llama-3.3-70b-versatile")).toBe(false);
  });
});

describe("buildChatBody reasoning-model compatibility", () => {
  it("uses max_completion_tokens and omits temperature for gpt-5.x", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    );
    expect(body.max_completion_tokens).toBeDefined();
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();
  });

  it("uses max_tokens and default temperature for non-reasoning models", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    );
    expect(body.max_tokens).toBeDefined();
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.temperature).toBe(0.2);
  });

  it("still honors an explicit maxTokens override for reasoning models", () => {
    const body = JSON.parse(
      buildChatBody({
        model: "o3-mini",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        maxTokens: 2048,
      }),
    );
    expect(body.max_completion_tokens).toBe(2048);
  });
});
