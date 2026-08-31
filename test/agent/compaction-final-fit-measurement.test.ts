import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";
import { accountAssembledRequest } from "../../src/agent/request-accounting.js";
import { measureCompactionFinalFit } from "../../src/agent/turn/compaction-final-fit.js";

const messages: ChatMessage[] = [
  { role: "system", content: "stable system prompt" },
  { role: "user", content: "continue" },
];

const tool = (name: string): ToolDefinition => ({
  name,
  description: `run ${name}`,
  parameters: { type: "object", properties: {} },
});

describe("compaction final fit", () => {
  it("skips accounting and tool selection without an explicit context limit", () => {
    const selectTools = vi.fn(() => [tool("first")]);
    expect(
      measureCompactionFinalFit({
        provider: "nvidia",
        model: "test-model",
        messages,
        contextLimitTokens: undefined,
        selectTools,
      }),
    ).toBeUndefined();
    expect(selectTools).not.toHaveBeenCalled();
  });

  it("omits empty tools after one dynamic selection", () => {
    const selectTools = vi.fn(() => []);
    const measured = measureCompactionFinalFit({
      provider: "nvidia",
      model: "test-model",
      messages,
      contextLimitTokens: 100_000,
      selectTools,
    });

    expect(measured).toEqual(
      accountAssembledRequest({
        provider: "nvidia",
        model: "test-model",
        messages,
        stream: true,
        contextLimitTokens: 100_000,
      }),
    );
    expect(selectTools).toHaveBeenCalledTimes(1);
  });

  it("uses the second dynamic tool selection when the first is non-empty", () => {
    const first = [tool("first")];
    const second = [tool("second")];
    const selectTools = vi
      .fn<() => readonly ToolDefinition[] | undefined>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const measured = measureCompactionFinalFit({
      provider: "nvidia",
      model: "test-model",
      messages,
      contextLimitTokens: 100_000,
      selectTools,
    });

    expect(measured).toEqual(
      accountAssembledRequest({
        provider: "nvidia",
        model: "test-model",
        messages,
        stream: true,
        tools: second,
        contextLimitTokens: 100_000,
      }),
    );
    expect(selectTools).toHaveBeenCalledTimes(2);
  });
});
