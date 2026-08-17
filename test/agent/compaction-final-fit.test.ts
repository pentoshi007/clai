import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/modes/agent.js";
import { deletePlan } from "../../src/store/plan.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { ChatMessage } from "../../src/types.js";
import { fingerprintFinalRequest, classifyPrefixAffinity } from "../../src/llm/request-fingerprint.js";
import { compactMessagesWithSummary } from "../../src/agent/context-manager.js";
import { DURABLE_ENVELOPE_PREFIX, isDurableEnvelopeContent } from "../../src/agent/durable-envelope.js";

const stream = vi.fn();

vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (
      req: unknown,
      onToken: (t: string) => void,
    ) => stream(req, onToken),
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

const GOOD_SUMMARY = [
  "- Goal: validate the final fit gate.",
  "- Decision: commits must fit the effective safe limit before splicing.",
  "- Remaining work: none for this fixture.",
].join("\n");

function chatBody(messages: readonly unknown[]): string {
  return JSON.stringify({ model: "fixture-model", messages, stream: false });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prefix affinity classification", () => {
  it("classifies exact append, partial, and not-eligible prefixes", () => {
    const shared = [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first answer" },
    ];
    const prior = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody(shared),
    )!;
    const appended = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody([...shared, { role: "user", content: "append instruction" }]),
    )!;
    const editedMiddle = fingerprintFinalRequest(
      { provider: "nvidia", model: "fixture-model" },
      chatBody([
        shared[0]!,
        { role: "user", content: "edited user turn" },
        shared[2]!,
        { role: "user", content: "append instruction" },
      ]),
    )!;
    const differentSerializer = fingerprintFinalRequest(
      { provider: "anthropic", model: "claude-sonnet-4-5" },
      chatBody([...shared, { role: "user", content: "append instruction" }]),
    )!;

    expect(classifyPrefixAffinity(prior, appended)).toBe(
      "exact_append_eligible",
    );
    expect(classifyPrefixAffinity(prior, editedMiddle)).toBe(
      "partial_prefix_eligible",
    );
    expect(classifyPrefixAffinity(prior, differentSerializer)).toBe(
      "not_eligible",
    );
    expect(classifyPrefixAffinity(undefined, appended)).toBe("unknown");
  });
});

describe("versioned envelope replacement", () => {
  it("leaves exactly one durable envelope after repeated compaction", async () => {
    const staleEnvelope: ChatMessage = {
      role: "system",
      content: `${DURABLE_ENVELOPE_PREFIX} (v1)\nolder durable state`,
    };
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "first request" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second request" },
      staleEnvelope,
      { role: "assistant", content: "second answer" },
      { role: "user", content: "latest request" },
    ];

    const result = await compactMessagesWithSummary(
      messages,
      async () => GOOD_SUMMARY,
      {
        budgetTokens: 0,
        keepRecent: 2,
        durableEnvelope: `${DURABLE_ENVELOPE_PREFIX} (v2)\ncurrent durable state`,
      },
    );

    const envelopes = result.messages.filter(
      (message) =>
        message.role === "system" && isDurableEnvelopeContent(message.content),
    );
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]!.content).toContain("(v2)");
  });
});

describe("compaction final fit gate", () => {
  beforeEach(async () => {
    stream.mockReset();
    await deletePlan("session-final-fit").catch(() => {});
  });

  function bigHistory(): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: "system", content: "system prompt" },
    ];
    for (let index = 0; index < 8; index += 1) {
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

  it("rejects the commit when the rebuilt request cannot fit the safe limit", async () => {
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        if (isCompactionRequest(req)) {
          onToken(GOOD_SUMMARY);
          return Promise.resolve({
            text: GOOD_SUMMARY,
            provider: "nvidia",
            model: "test-model",
          });
        }
        return Promise.reject(
          new Error("413 request exceeded the provider input limit"),
        );
      },
    );

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-final-fit"),
      history: bigHistory(),
      maxSteps: 2,
      contextLimitTokens: 30_000,
      onEvent: (event) => events.push(event),
    }).catch(() => undefined);

    const completed = events.find(
      (event) => event.type === "compaction-completed",
    );
    expect(completed).toBeUndefined();
    const failed = events.find(
      (event) => event.type === "compaction-failed",
    );
    expect(failed?.message).toMatch(/context limit/i);
    expect(events.some((event) => event.type === "turn-error")).toBe(true);
  });

  it("reports before and after in the same assembled-request metric", async () => {
    stream.mockImplementation(
      (
        req: { messages?: Array<{ role: string; content: string }> },
        onToken: (t: string) => void,
      ) => {
        if (isCompactionRequest(req)) {
          onToken(GOOD_SUMMARY);
          return Promise.resolve({
            text: GOOD_SUMMARY,
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

    const history: ChatMessage[] = [
      { role: "system", content: "system prompt" },
    ];
    for (let index = 0; index < 6; index += 1) {
      history.push({
        role: "user",
        content: `request ${index} with a few words`,
      });
      history.push({
        role: "assistant",
        content: `answer ${index} with a few words`,
      });
    }

    const events: AgentEvent[] = [];
    await runAgent("continue", {
      session: makeSession("session-final-fit"),
      history,
      maxSteps: 2,
      contextLimitTokens: 175_000,
      onEvent: (event) => events.push(event),
    });

    const started = events.find((event) => event.type === "compaction-start");
    const completed = events.find(
      (event) => event.type === "compaction-completed",
    );
    expect(started).toBeDefined();
    expect(completed).toBeDefined();
    expect(completed!.contextScope).toBe("assembled-request");
    expect(completed!.beforeTokens).toBe(started!.beforeTokens);
    expect(completed!.afterTokens).toBeLessThan(completed!.beforeTokens);
  });
});
