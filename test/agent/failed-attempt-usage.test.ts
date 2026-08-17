import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/modes/agent.js";
import { deletePlan } from "../../src/store/plan.js";
import type { AgentEvent } from "../../src/agent/events.js";

const stream = vi.fn();
const complete = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
      options?: { onStatus?: (message: string) => void },
    ) => stream(req, onToken, options),
    completeWithProvider: (req: unknown) => complete(req),
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

function failedUsageError(): Error {
  const error = new Error(
    "The model completed without a visible answer",
  );
  (error as { operationUsage?: unknown }).operationUsage = {
    attempts: [
      {
        sequence: 1,
        provider: "nvidia",
        model: "test-model",
        mode: "stream",
        reason: "initial",
        outcome: "failure",
        usage: {
          kind: "known",
          value: {
            promptTokens: 3_000,
            completionTokens: 40,
            totalTokens: 3_040,
            exact: true,
          },
        },
      },
    ],
    aggregate: {
      status: "known",
      knownAdmissions: 1,
      unknownAdmissions: 0,
      usage: {
        promptTokens: 3_000,
        completionTokens: 40,
        totalTokens: 3_040,
        exact: true,
      },
    },
  };
  return error;
}

describe("failed attempt usage aggregation", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    await deletePlan("session-failed-usage").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits the discarded attempt's usage before the successful retry", async () => {
    let call = 0;
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        call += 1;
        const compactionInstruction =
          req.messages?.at(-1)?.content.toLowerCase() ?? "";
        if (compactionInstruction.includes("continuation memory")) {
          onToken("summary text");
          return Promise.resolve({
            text: "summary text",
            provider: "nvidia",
            model: "test-model",
          });
        }
        if (call === 1) {
          return Promise.reject(failedUsageError());
        }
        onToken("recovered answer");
        return Promise.resolve({
          text: "recovered answer",
          provider: "nvidia",
          model: "test-model",
          usage: {
            promptTokens: 3_100,
            completionTokens: 20,
            totalTokens: 3_120,
            exact: true,
          },
        });
      },
    );

    const events: AgentEvent[] = [];
    const output = await runAgent("hi", {
      session: makeSession("session-failed-usage"),
      maxSteps: 2,
      onEvent: (event) => events.push(event),
    });

    expect(output).toContain("recovered answer");
    const usageEvents = events.filter(
      (event) => event.type === "token-usage",
    );
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({
      usage: { promptTokens: 3_000, completionTokens: 40, totalTokens: 3_040 },
      provider: "nvidia",
      model: "test-model",
    });
    expect(usageEvents[1]).toMatchObject({
      usage: { promptTokens: 3_100, completionTokens: 20, totalTokens: 3_120 },
    });
  });

  it("emits nothing extra when the failed attempt reports no usage", async () => {
    let call = 0;
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        call += 1;
        const compactionInstruction =
          req.messages?.at(-1)?.content.toLowerCase() ?? "";
        if (compactionInstruction.includes("continuation memory")) {
          onToken("summary text");
          return Promise.resolve({
            text: "summary text",
            provider: "nvidia",
            model: "test-model",
          });
        }
        if (call === 1) {
          return Promise.reject(new Error("connection glitch mid-request"));
        }
        onToken("recovered answer");
        return Promise.resolve({
          text: "recovered answer",
          provider: "nvidia",
          model: "test-model",
          usage: {
            promptTokens: 3_100,
            completionTokens: 20,
            totalTokens: 3_120,
            exact: true,
          },
        });
      },
    );

    const events: AgentEvent[] = [];
    await runAgent("hi", {
      session: makeSession("session-failed-usage"),
      maxSteps: 2,
      onEvent: (event) => events.push(event),
    });

    const usageEvents = events.filter(
      (event) => event.type === "token-usage",
    );
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      usage: { promptTokens: 3_100, totalTokens: 3_120 },
    });
  });
});
