import { describe, expect, it } from "vitest";

import { createCompactionRequestEstimator } from "../../src/agent/turn/compaction-request-estimator.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";

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
      provider: "openai",
      model: "model",
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
      provider: "openai",
      model: "model",
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
});
