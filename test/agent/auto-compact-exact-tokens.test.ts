import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/modes/agent.js";
import { deletePlan } from "../../src/store/plan.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { resetRequestTokenCalibration } from "../../src/llm/token-estimate-calibration.js";

const stream = vi.fn();
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
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
  const actual =
    await importActual<typeof import("../../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function smallHistory(count: number): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let i = 0; i < count; i += 1) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i} with a few words`,
    });
  }
  return messages;
}

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

describe("auto-compaction on provider-exact tokens and session limits", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    runTool.mockReset();
    runTool.mockResolvedValue({ ok: true, output: "tool-output" });
    complete.mockResolvedValue({
      text: "## Work completed\nCompleted compaction.\n## Remaining work\nContinue.",
      provider: "nvidia",
      model: "test-model",
    });
    resetRequestTokenCalibration({ removePersisted: true });
    await cleanUnsuedPlans();
  });

  async function cleanUnsuedPlans() {
    await deletePlan("session-exact-compact").catch(() => {});
    await deletePlan("session-live-limit").catch(() => {});
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not compact a small current request because an older provider count was large", async () => {
    const history = smallHistory(12);
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
          onToken("");
          return Promise.resolve({
            text: "",
            provider: "nvidia",
            model: "test-model",
            toolCalls: [{ id: "c1", name: "sysinfo", args: {} }],
            usage: {
              promptTokens: 180_000,
              completionTokens: 12,
              totalTokens: 180_012,
              exact: true,
            },
            operationUsage: {
              attempts: [
                {
                  sequence: 1,
                  provider: "nvidia",
                  model: "test-model",
                  mode: "stream",
                  reason: "initial",
                  outcome: "success",
                  usage: {
                    kind: "known",
                    value: {
                      promptTokens: 180_000,
                      completionTokens: 12,
                      totalTokens: 180_012,
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
                  promptTokens: 180_000,
                  completionTokens: 12,
                  totalTokens: 180_012,
                  exact: true,
                },
              },
            },
          });
        }
        onToken("done");
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "test-model",
        });
      },
    );

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-exact-compact"),
      provider: "nvidia",
      model: "test-model",
      history,
      maxSteps: 6,
      contextLimitTokens: 175_000,
      onEvent: (e) => events.push(e),
    });

    expect(events.some((e) => e.type === "compaction-start")).toBe(false);
    expect(events.some((e) => e.type === "compaction-completed")).toBe(false);
    expect(
      events.find((event) => event.type === "token-usage"),
    ).toMatchObject({
      attempt: {
        kind: "generation",
        sequence: 1,
        provider: "nvidia",
        model: "test-model",
        mode: "stream",
        reason: "initial",
        outcome: "success",
      },
    });
    const estimates = events
      .filter((event) => event.type === "context-estimate")
      .map((event) => event.estimatedTokens);
    expect(estimates.length).toBeGreaterThan(0);
    expect(Math.max(...estimates)).toBeLessThan(122_500);
  });

  it("picks up session context-limit changes against the current request on the next round", async () => {
    const history = smallHistory(12);
    history.splice(1, 1, { role: "user", content: "x ".repeat(198_000) });
    let liveLimit: number | undefined = undefined;
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
        if (call <= 2) {
          onToken("");
          return Promise.resolve({
            text: "",
            provider: "nvidia",
            model: "test-model",
            toolCalls: [{ id: `c${call}`, name: "sysinfo", args: {} }],
            usage: {
              promptTokens: 130_000,
              completionTokens: 5,
              totalTokens: 130_005,
              exact: true,
            },
          });
        }
        onToken("done");
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "test-model",
        });
      },
    );
    runTool.mockImplementation(async () => {
      liveLimit = 175_000;
      return { ok: true, output: "tool-output" };
    });

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-live-limit"),
      provider: "nvidia",
      model: "test-model",
      history,
      maxSteps: 8,
      getContextLimitTokens: () => liveLimit,
      onEvent: (e) => events.push(e),
    });

    expect(
      events.some((e) => e.type === "compaction-start"),
      "expected compaction once the mid-run limit lowered the trigger below the current assembled request",
    ).toBe(true);
  });
});
