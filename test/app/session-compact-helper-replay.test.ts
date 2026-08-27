import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";

const complete = vi.fn();
const stream = vi.fn();

vi.mock("../../src/llm/router.js", () => ({
  completeWithProvider: (req: unknown, options?: unknown) =>
    complete(req, options),
  streamWithProvider: (
    req: unknown,
    onToken: (token: string) => void,
    options?: unknown,
  ) => stream(req, onToken, options),
}));

const { runSessionCompaction } = await import(
  "../../src/app/controllers/session-compact-helper.js"
);
const { EventSequencer } = await import("../../src/app/events/sequencer.js");

const SUMMARY =
  "## Work completed\n- Did the thing.\n\n## Remaining work\n- Nothing.";

function okResult() {
  return {
    text: SUMMARY,
    provider: "free",
    model: "free-1/deepseek-v4-flash-free",
    finishReason: "stop",
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, exact: true },
  };
}

const SNAPSHOT = {
  provider: "free" as const,
  model: "free-1/deepseek-v4-flash-free",
  temperature: 0.7,
  thinking: { enabled: true, effort: "medium" as const },
  messages: [
    { role: "system" as const, content: "stable constitution" },
    { role: "user" as const, content: "build the feature" },
    { role: "assistant" as const, content: "working on it" },
  ],
};

function harness(history: ChatMessage[]) {
  const committed: ChatMessage[][] = [];
  return {
    committed,
    options: {
      history,
      keepRecent: 2,
      signal: new AbortController().signal,
      provider: "free" as const,
      model: "free-1/deepseek-v4-flash-free",
      successfulRequest: SNAPSHOT,
      contextLimitTokens: 1_000_000,
      persist: false,
      compactionId: "c1",
      sequencer: new EventSequencer("sess-test" as never),
      emit: () => undefined,
      isCurrent: () => true,
      commit: (result: { messages: ChatMessage[] }) => {
        committed.push(result.messages);
      },
      persistNow: async () => undefined,
    },
  };
}

describe("runSessionCompaction cache-preserving replay", () => {
  beforeEach(() => {
    complete.mockReset();
    stream.mockReset();
  });

  it("replays the last successful request verbatim and appends the instruction", async () => {
    complete.mockResolvedValueOnce(okResult());
    const history: ChatMessage[] = [
      ...SNAPSHOT.messages,
      { role: "assistant", content: "done — feature built" },
      { role: "user", content: "now compact" },
    ];

    await runSessionCompaction(harness(history).options);

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0] as {
      temperature?: number;
      thinking?: unknown;
      messages: Array<{ role: string; content: string }>;
    };
    // Every prior prompt token is a strict prefix of the compaction request.
    expect(sent.messages.slice(0, SNAPSHOT.messages.length)).toEqual(
      SNAPSHOT.messages,
    );
    const last = sent.messages.at(-1)!;
    expect(last.role).toBe("user");
    expect(last.content).toContain("entire conversation above this instruction");
    // Sampling and reasoning mirror the captured request — the cached prefix
    // identity is untouched.
    expect(sent.temperature).toBe(0.7);
    expect(sent.thinking).toEqual({ enabled: true, effort: "medium" });
  });

  it("keeps restored request accounting instead of replacing it with a stale replay", async () => {
    stream.mockResolvedValueOnce(okResult());
    const successfulRequest = {
      ...SNAPSHOT,
      messages: [
        { role: "system" as const, content: "stable constitution" },
        {
          role: "user" as const,
          content: "historical user detail ".repeat(12_000),
        },
        {
          role: "assistant" as const,
          content: "historical assistant detail ".repeat(12_000),
        },
      ],
    };
    const history: ChatMessage[] = [
      ...successfulRequest.messages,
      { role: "assistant", content: "done — feature built" },
      { role: "user", content: "now compact" },
    ];
    const events: AnyAppEvent[] = [];
    const { options } = harness(history);

    await runSessionCompaction({
      ...options,
      successfulRequest,
      requestTokensBefore: 78_200,
      persist: true,
      emit: (event) => events.push(event),
    });

    const started = events.find((event) => event.type === "compaction-started");
    const completed = events.find(
      (event) => event.type === "compaction-completed",
    );
    expect(started?.payload.beforeTokens).toBe(78_200);
    expect(completed?.payload).toMatchObject({
      beforeTokens: 78_200,
      contextScope: "assembled-request",
    });
    expect(
      completed?.type === "compaction-completed"
        ? completed.payload.afterTokens
        : 78_200,
    ).toBeLessThan(78_200);
  });

  it("falls back to transcript-rendered requests when the replay cannot fit", async () => {
    complete.mockResolvedValueOnce(okResult());
    const history: ChatMessage[] = [
      ...SNAPSHOT.messages,
      { role: "assistant", content: "done — feature built" },
      { role: "user", content: "now compact" },
    ];
    const { options } = harness(history);

    await runSessionCompaction({
      ...options,
      // A tiny window cannot hold the replay, so the legacy transcript path
      // must take over instead of failing closed.
      contextLimitTokens: 64,
    });

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = complete.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: string }>;
    };
    // No verbatim replay of the snapshot; the material travels as transcript
    // text inside the instruction prompt.
    expect(sent.messages[0]).not.toEqual(SNAPSHOT.messages[0]);
    expect(
      sent.messages.some(
        (message) =>
          message.role === "user" && message.content.includes("build the feature"),
      ),
    ).toBe(true);
  });
});
