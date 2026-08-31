import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";
import { executeAutomaticCompaction } from "../../src/agent/turn/automatic-compaction-execution.js";
import {
  DURABLE_ENVELOPE_PREFIX,
  isDurableEnvelopeContent,
} from "../../src/agent/durable-envelope.js";

const usableSummary = [
  "- Goal: preserve automatic compaction execution.",
  "- Decision: use one direct summarization admission.",
  "- Remaining work: validate the resulting request.",
].join("\n");

const messages = (): ChatMessage[] => [
  { role: "system", content: "stable system prompt" },
  { role: "user", content: "first request " + "x".repeat(2_000) },
  { role: "assistant", content: "first answer " + "y".repeat(2_000) },
  { role: "user", content: "second request" },
  { role: "assistant", content: "second answer" },
];

const tools: ToolDefinition[] = [
  {
    name: "fs.read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
  },
];

describe("automatic compaction execution", () => {
  it("uses the direct single-admission path with schema-adjusted budget", async () => {
    const summarize = vi.fn(async () => usableSummary);
    const result = await executeAutomaticCompaction({
      messages: messages(),
      summarize,
      tools,
      provider: "nvidia",
      model: "test-model",
      contextLimitTokens: 1_000_000,
      keepRecent: 2,
      forceDirectSinglePass: false,
      durableEnvelope: undefined,
    });

    expect(result.strategy).toBe("direct");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(summarize.mock.calls[0]?.[1]).toMatchObject({ phase: "single" });
  });

  it("forces a preflighted replay through the direct path at a zero raw budget", async () => {
    const summarize = vi.fn(async () => usableSummary);
    const durableEnvelope = `${DURABLE_ENVELOPE_PREFIX} (canonical; authoritative over summarized narrative)\nProject root: /workspace`;
    const result = await executeAutomaticCompaction({
      messages: messages(),
      summarize,
      tools,
      provider: "nvidia",
      model: "test-model",
      contextLimitTokens: 1,
      keepRecent: 2,
      forceDirectSinglePass: true,
      durableEnvelope,
    });

    expect(result.strategy).toBe("direct");
    expect(
      result.messages.some(
        (message) =>
          message.role === "system" &&
          isDurableEnvelopeContent(message.content) &&
          message.content === durableEnvelope,
      ),
    ).toBe(true);
  });

  it("falls back to the model context window when no limit is supplied", async () => {
    const result = await executeAutomaticCompaction({
      messages: messages(),
      summarize: async () => usableSummary,
      tools: undefined,
      provider: "nvidia",
      model: "test-model",
      contextLimitTokens: undefined,
      keepRecent: 2,
      forceDirectSinglePass: false,
      durableEnvelope: undefined,
    });

    expect(result.summarized).toBe(true);
    expect(result.strategy).toBe("direct");
  });
});
