import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/modes/agent.js";
import { deletePlan } from "../../src/store/plan.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { resetRequestTokenCalibration } from "../../src/llm/token-estimate-calibration.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
    ) => stream(req, onToken),
    completeWithProvider: (req: unknown) => complete(req),
  };
});

vi.mock("../../src/tools/registry.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: async () => ({ ok: true, output: "tool-output" }),
  };
});

vi.mock("../../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

function smallHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "user",
      content: `request ${index} with a few words`,
    });
    messages.push({
      role: "assistant",
      content: `answer ${index} with a few words`,
    });
  }
  return messages;
}

function bigHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "user",
      content: `request ${index}: ${"x".repeat(9_000)}`,
    });
    messages.push({
      role: "assistant",
      content: `answer ${index}: ${"y".repeat(9_000)}`,
    });
  }
  return messages;
}

function isCompactionRequest(
  req: { messages?: Array<{ role: string; content: string }> },
): boolean {
  const hay = [
    req.messages?.at(-1)?.content ?? "",
    req.messages?.[0]?.content ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes("continuation memory");
}

describe("automatic compaction single-admission policy", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    resetRequestTokenCalibration({ removePersisted: true });
    await deletePlan("session-auto-single-admission").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches exactly one summarization request per operation and never quality-retries", async () => {
    const compactionPrompts: string[] = [];
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        if (isCompactionRequest(req)) {
          compactionPrompts.push(req.messages!.at(-1)!.content);
          onToken("");
          return Promise.resolve({
            text: "",
            provider: "nvidia",
            model: "test-model",
            finishReason: "length",
          });
        }
        onToken("done");
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "test-model",
          usage: {
            promptTokens: 180_000,
            completionTokens: 12,
            totalTokens: 180_012,
            exact: true,
          },
        });
      },
    );

    const history = smallHistory();
    history.splice(1, 1, {
      role: "user",
      content: "x ".repeat(160_000),
    });
    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-auto-single-admission"),
      provider: "nvidia",
      model: "test-model",
      history,
      maxSteps: 4,
      contextLimitTokens: 175_000,
      onEvent: (event) => events.push(event),
    }).catch((error: unknown) => {
      if (
        !(error instanceof Error) ||
        !/exceeds the effective safe context/i.test(error.message)
      ) {
        throw error;
      }
    });

    const starts = events.filter(
      (event) => event.type === "compaction-start",
    ).length;
    expect(starts).toBeGreaterThan(0);
    expect(compactionPrompts).toHaveLength(starts);
    expect(
      compactionPrompts.every((prompt) => !prompt.includes("QUALITY RETRY")),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "compaction-failed"),
    ).toBe(true);
  });

  it("never map/reduces an oversized history in automatic mode", async () => {
    let summaryDispatches = 0;
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        if (isCompactionRequest(req)) {
          summaryDispatches += 1;
          onToken(
            "- Goal: keep the slice admission count at one.\n- Decision: emergency slice retained the middle.",
          );
          return Promise.resolve({
            text: "- Goal: keep the slice admission count at one.\n- Decision: emergency slice retained the middle.",
            provider: "nvidia",
            model: "test-model",
          });
        }
        onToken("done");
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "test-model",
          usage: {
            promptTokens: 180_000,
            completionTokens: 12,
            totalTokens: 180_012,
            exact: true,
          },
        });
      },
    );

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-auto-single-admission"),
      history: bigHistory(),
      maxSteps: 2,
      contextLimitTokens: 30_000,
      onEvent: (event) => events.push(event),
    }).catch((error: unknown) => {
      if (!(error instanceof Error) || !/exceeds the effective safe context/i.test(error.message)) {
        throw error;
      }
    });

    expect(summaryDispatches).toBe(1);
    expect(events.some((event) => event.type === "compaction-start")).toBe(
      true,
    );
    expect(
      events.some(
        (event) =>
          event.type === "compaction-completed" ||
          event.type === "compaction-failed",
      ),
    ).toBe(true);
  });

  it("retains the active history and continues after an opaque compaction rejection", async () => {
    const generic = Object.assign(
      new Error(
        "Bynara stream error: The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.",
      ),
      { status: 400 },
    );
    let compactionDispatches = 0;
    let turnDispatches = 0;
    stream.mockImplementation(
      (
        req: {
          purpose?: string;
          messages?: Array<{ role: string; content: string }>;
        },
        onToken: (t: string) => void,
      ) => {
        if (req.purpose === "compaction") {
          compactionDispatches += 1;
          return Promise.reject(generic);
        }
        turnDispatches += 1;
        onToken("continued answer");
        return Promise.resolve({
          text: "continued answer",
          provider: "nvidia",
          model: "test-model",
          usage: {
            promptTokens: 190_000,
            completionTokens: 12,
            totalTokens: 190_012,
            exact: true,
          },
        });
      },
    );

    const history = smallHistory();
    history.splice(1, 1, {
      role: "user",
      content: "x ".repeat(330_000),
    });
    const original = structuredClone(history);
    const events: AgentEvent[] = [];
    const result = await runAgent("continue", {
      session: makeSession("session-auto-single-admission"),
      provider: "nvidia",
      model: "test-model",
      history,
      maxSteps: 1,
      contextLimitTokens: 300_000,
      onEvent: (event) => events.push(event),
    });

    expect(result).toContain("continued answer");
    const compactionStarts = events.filter(
      (event) => event.type === "compaction-start",
    ).length;
    expect(compactionStarts).toBeGreaterThan(0);
    expect(compactionDispatches).toBe(compactionStarts * 2);
    expect(turnDispatches).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "compaction-failed")).toBe(true);
    expect(events.some((event) => event.type === "turn-end")).toBe(true);
    expect(history).toEqual(original);
  });
});
