import { describe, expect, it, vi } from "vitest";

import {
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
} from "../../src/agent/compaction-summary.js";
import { executeCompactionSummary } from "../../src/agent/compaction-executor.js";
import { createCompactionSummarizer } from "../../src/agent/turn/compaction-summarizer.js";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";

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

const history: ChatMessage[] = [{ role: "user", content: "history" }];

describe("createCompactionSummarizer", () => {
  it("uses source messages and tools for map stages without streaming deltas", async () => {
    const execute = vi.fn<typeof executeCompactionSummary>().mockResolvedValue("map summary");
    const writeDelta = vi.fn();
    const sourceMessages: ChatMessage[] = [{ role: "tool", content: "source" }];
    const summarize = createCompactionSummarizer({
      provider: "openai",
      model: "model",
      history,
      state: { activeId: "compact-1" },
      currentContextLimitTokens: () => 1000,
      toolsForSourceMessages: () => [tool],
      writeDelta,
      execute,
    });
    await expect(
      summarize("map prompt", { phase: "map", sourceMessages }),
    ).resolves.toBe("map summary");
    expect(execute).toHaveBeenCalledWith({
      provider: "openai",
      model: "model",
      systemContent: COMPACTION_SYSTEM_PROMPT,
      prompt: "map prompt",
      maxTokens: COMPACTION_MAP_MAX_COMPLETION_TOKENS,
      signal: undefined,
      sourceMessages,
      tools: [tool],
      qualityRetry: false,
      retryOnServerError: true,
      stream: true,
      onToken: undefined,
    });
    expect(writeDelta).not.toHaveBeenCalled();
  });

  it("replays the successful request and streams final-stage tokens", async () => {
    const execute = vi.fn<typeof executeCompactionSummary>().mockResolvedValue("final summary");
    const writeDelta = vi.fn();
    const replay = {
      provider: "openai" as const,
      model: "model",
      messages: [{ role: "user" as const, content: "cached" }],
    };
    const summarize = createCompactionSummarizer({
      provider: "openai",
      model: "model",
      signal: AbortSignal.abort(),
      history,
      state: { activeId: "compact-2", replaySnapshot: replay },
      currentContextLimitTokens: () => 2048,
      toolsForSourceMessages: () => [tool],
      writeDelta,
      execute,
    });
    await expect(summarize("final prompt", { phase: "reduce" })).resolves.toBe(
      "final summary",
    );
    const request = execute.mock.calls[0]![0];
    expect(request).toMatchObject({
      provider: "openai",
      model: "model",
      systemContent: COMPACTION_SYSTEM_PROMPT,
      prompt: "final prompt",
      maxTokens: COMPACTION_MAX_COMPLETION_TOKENS,
      baseRequest: replay,
      history,
      contextLimitTokens: 2048,
      qualityRetry: false,
      retryOnServerError: true,
      stream: true,
    });
    request.onToken?.("chunk", true);
    expect(writeDelta).toHaveBeenCalledWith("compact-2", "chunk", true);
  });
});
