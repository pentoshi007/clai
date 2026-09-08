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
  it("accounts against the model window when no explicit context limit is set", () => {
    const tools = [tool("first")];
    const selectTools = vi.fn(() => tools);
    expect(
      measureCompactionFinalFit({
        provider: "nvidia",
        model: "test-model",
        messages,
        contextLimitTokens: undefined,
        selectTools,
      }),
    ).toEqual(
      accountAssembledRequest({
        provider: "nvidia",
        model: "test-model",
        messages,
        stream: true,
        tools,
      }),
    );
    expect(selectTools).toHaveBeenCalledTimes(1);
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

  it("uses one stable dynamic tool selection", () => {
    const selected = [tool("first")];
    const selectTools = vi.fn<() => readonly ToolDefinition[] | undefined>(() => selected);
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
        tools: selected,
        contextLimitTokens: 100_000,
      }),
    );
    expect(selectTools).toHaveBeenCalledTimes(1);
  });
});
