import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { AgentOptions } from "../../src/modes/agent.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";

const lifecycle = vi.hoisted(() => [] as string[]);
const receivedOptions = vi.hoisted(() => [] as AgentOptions[]);

vi.mock("../../src/mcp/runtime.js", () => ({
  McpRuntime: class {
    start(): Promise<void> {
      lifecycle.push("mcp:start");
      return Promise.resolve();
    }

    closeAll(): Promise<void> {
      lifecycle.push("mcp:close");
      return Promise.resolve();
    }
  },
}));

vi.mock("../../src/modes/agent.js", () => ({
  runAgent: async (_prompt: string, options: AgentOptions): Promise<string> => {
    lifecycle.push("agent:run");
    receivedOptions.push(options);
    options.onOutcome?.(
      createTurnOutcome({
        status: "succeeded",
        answer: "done",
        steps: 1,
        remainingCriteria: [],
      }),
    );
    return "done";
  },
}));

vi.mock("../../src/interactive-session/manager.js", () => ({
  interactiveSessionManager: {
    closeAll: async () => ({ failures: [] }),
  },
}));

vi.mock("../../src/store/history.js", () => ({
  saveSession: async () => undefined,
}));

vi.mock("../../src/noninteractive/readline-prompts.js", () => ({
  releaseInteractiveStdin: () => undefined,
}));

import { startNoninteractive } from "../../src/noninteractive/start-noninteractive.js";

describe("noninteractive MCP lifecycle", () => {
  it("keeps the default-off runtime dormant, injects it, and closes it", async () => {
    lifecycle.length = 0;
    receivedOptions.length = 0;
    const out = new PassThrough();
    const err = new PassThrough();
    const input = new PassThrough();

    const result = await startNoninteractive({
      prompt: "answer",
      mode: "agent",
      noHistory: true,
      out,
      err,
      input,
      color: false,
      unicode: false,
    });

    expect(result.answer).toBe("done");
    expect(receivedOptions).toHaveLength(1);
    expect(receivedOptions[0]?.mcp).toBeDefined();
    expect(lifecycle).toEqual(["agent:run", "mcp:close"]);
  });
});
