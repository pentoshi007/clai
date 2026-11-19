import { describe, expect, it } from "vitest";

import { createCompactionRequestEstimator } from "../../src/agent/turn/compaction-request-estimator.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import type { ChatMessage, ProviderId, ToolDefinition } from "../../src/types.js";

const messages: ChatMessage[] = [{ role: "user", content: "estimate this request" }];
const tool: ToolDefinition = {
  name: "fs.read",
  wireName: "fs_read",
  description: "read",
  parameters: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

describe("createCompactionRequestEstimator", () => {
  it("uses canonical assembled-request accounting without tools", () => {
    const estimate = createCompactionRequestEstimator({
      provider: () => "openai",
      model: () => "model",
      selectTools: () => undefined,
    });
    expect(estimate(messages)).toBe(
      accountAssembledRequest({
        provider: "openai",
        model: "model",
        messages,
        stream: true,
      }).accounting.requestTokens,
    );
  });

  it("includes selected tool schemas", () => {
    const estimate = createCompactionRequestEstimator({
      provider: () => "openai",
      model: () => "model",
      selectTools: () => [tool],
    });
    expect(estimate(messages)).toBe(
      accountAssembledRequest({
        provider: "openai",
        model: "model",
        messages,
        stream: true,
        tools: [tool],
      }).accounting.requestTokens,
    );
  });

  it("uses the new route's replay policy after a fallback", () => {
    let provider: ProviderId = "anthropic";
    let model = "claude-3-5-haiku-latest";
    const history: ChatMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: "",
        reasoningBlock: { text: "analysis".repeat(100), signature: "sig" },
        toolCalls: [{ id: "read-1", name: "fs.read", args: { path: "project.txt" } }],
      },
      { role: "tool", content: "file contents", toolCallId: "read-1" },
    ];
    const estimate = createCompactionRequestEstimator({
      provider: () => provider,
      model: () => model,
      selectTools: () => undefined,
    });
    const initial = estimate(history);
    provider = "nvidia";
    model = "meta/llama-3.3-70b-instruct";
    const fallback = accountAssembledRequest({ provider, model, messages: history, stream: true }).accounting;
    expect(estimate(history)).toBe(fallback.requestTokens);
    expect(fallback.artifactTokens).toBe(0);
    expect(estimate(history)).toBeLessThan(initial);
  });
});
