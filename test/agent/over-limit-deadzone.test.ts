import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
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
  } as never;
}

function deadZoneHistory(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
  for (let index = 0; index < 6; index += 1) {
    messages.push({
      role: "user",
      content: `request ${index}: ${"x".repeat(42_000)}`,
    });
    messages.push({
      role: "assistant",
      content: `answer ${index}: ${"y".repeat(42_000)}`,
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

describe("auto-compaction fires before the dispatch block (dead zone regression)", () => {
  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    resetRequestTokenCalibration({ removePersisted: true });
    await deletePlan("session-over-limit-deadzone").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("auto-compacts an oversized history instead of blocking dispatch between the safe limit and the stale trigger", async () => {
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        if (isCompactionRequest(req)) {
          onToken("- Goal: shrink the oversized history into durable memory.\n- Decisions: emergency slice retained the recent tail.");
          return Promise.resolve({
            text: "- Goal: shrink the oversized history into durable memory.\n- Decisions: emergency slice retained the recent tail.",
            provider: "nvidia",
            model: "claude-sonnet-4",
          });
        }
        onToken("done");
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "claude-sonnet-4",
          usage: {
            promptTokens: 90_000,
            completionTokens: 4,
            totalTokens: 90_004,
            exact: true,
          },
        });
      },
    );

    const events: AgentEvent[] = [];
    const answer = await runAgent("continue", {
      session: makeSession("session-over-limit-deadzone"),
      provider: "nvidia",
      model: "claude-sonnet-4",
      history: deadZoneHistory(),
      maxSteps: 3,
      onEvent: (event) => events.push(event),
    });

    expect(answer).toContain("done");
    expect(
      events.some((event) => event.type === "compaction-start"),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "compaction-completed" ||
          event.type === "compaction-failed",
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.type === "turn-error"),
    ).toBe(false);
    expect(stream.mock.calls.length).toBeGreaterThan(0);
  });
});
