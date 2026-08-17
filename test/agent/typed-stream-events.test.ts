import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { deletePlan } from "../../src/store/plan.js";
import { REASONING_OPEN, REASONING_CLOSE } from "../../src/llm/reasoning-marker.js";
import { clearThinking, getAllThinking } from "../../src/ui/thinking.js";

const stream = vi.fn();
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
      opts?: { onStreamEvent?: (e: unknown) => void },
    ) => stream(req, onToken, opts),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

interface CapturedRound {
  readonly messages: readonly string[];
}

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

async function driveAgent(
  sessionId: string,
  produce: (req: unknown, onToken: (t: string) => void, opts?: { onStreamEvent?: (e: unknown) => void }) => any,
  rounds = 1,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const { runAgent } = await import("../../src/modes/agent.js");
  stream.mockImplementation(async (req: unknown, onToken: (t: string) => void, opts?: { onStreamEvent?: (e: unknown) => void }) => {
    const result = produce(req, onToken, opts);
    return Promise.resolve(result);
  });
  await runAgent("answer directly without tools", {
    session: makeSession(sessionId),
    history: [{ role: "system", content: "sys" } as ChatMessage],
    maxSteps: 4,
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe("typed reasoning stream events through the agent runner", () => {
  const captured: CapturedRound[] = [];

  beforeEach(async () => {
    captured.length = 0;
    clearThinking();
    stream.mockReset();
    complete.mockReset();
    runTool.mockReset();
    runTool.mockResolvedValue({ ok: true, output: "tool-output" });
    await deletePlan("session-typed-stream").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders typed reasoning deltas as the thinking trace and keeps the answer channel clean", async () => {
    const events = await driveAgent("session-typed-stream", (_req, onToken, opts) => {
      opts?.onStreamEvent?.({ type: "reasoning_delta", text: "planning the reply" });
      onToken("The answer.");
      return {
        text: "The answer.",
        provider: "nvidia",
        model: "test-model",
        finishReason: "stop",
      };
    });

    const thinkingDeltas = events.filter(
      (e) => e.type === "thinking-delta",
    ) as Array<{ type: "thinking-delta"; text: string }>;
    expect(thinkingDeltas.map((e) => e.text).join("")).toBe(
      "planning the reply",
    );

    const assistantDeltas = events.filter(
      (e) => e.type === "assistant-delta",
    ) as Array<{ type: "assistant-delta"; text: string }>;
    expect(assistantDeltas.map((e) => e.text).join("")).toBe("The answer.");

    expect(events.some((e) => e.type === "status" && e.text === "thinking")).toBe(
      true,
    );

    expect(getAllThinking()).toContain("planning the reply");

    const assistantMessage = events.find(
      (e) => e.type === "assistant-message",
    ) as { type: "assistant-message"; text: string } | undefined;
    expect(assistantMessage?.text).toBe("The answer.");
  });

  it("still splits legacy marker-encoded streams from older transports", async () => {
    const events = await driveAgent("session-typed-stream", (_req, onToken) => {
      onToken(`${REASONING_OPEN}legacy reasoning${REASONING_CLOSE}`);
      onToken("Legacy answer.");
      return {
        text: `${REASONING_OPEN}legacy reasoning${REASONING_CLOSE}Legacy answer.`,
        provider: "nvidia",
        model: "test-model",
        finishReason: "stop",
      };
    });

    const thinkingDeltas = events.filter(
      (e) => e.type === "thinking-delta",
    ) as Array<{ type: "thinking-delta"; text: string }>;
    expect(thinkingDeltas.map((e) => e.text).join("")).toBe("legacy reasoning");

    const assistantMessage = events.find(
      (e) => e.type === "assistant-message",
    ) as { type: "assistant-message"; text: string } | undefined;
    expect(assistantMessage?.text).toBe("Legacy answer.");
    expect(assistantMessage?.text).not.toMatch(/[\ue000\ue001]/);
  });

  it("recovers typed reasoning from the result channel when no events were delivered", async () => {
    const events = await driveAgent("session-typed-stream", (_req, onToken) => {
      onToken("Fallback answer.");
      return {
        text: "Fallback answer.",
        provider: "nvidia",
        model: "test-model",
        finishReason: "stop",
        reasoningBlock: { text: "reasoning from the result" },
      };
    });

    const assistantMessage = events.find(
      (e) => e.type === "assistant-message",
    ) as { type: "assistant-message"; text: string } | undefined;
    expect(assistantMessage?.text).toBe("Fallback answer.");
    expect(getAllThinking()).toContain("reasoning from the result");
  });
});
