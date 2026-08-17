import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  accountAssembledRequest,
  accountRequestPlan,
  estimateImageTokens,
  estimateMessageTokens,
  estimateTextTokens,
  resolveEffectiveContextLimit,
  RequestOverLimitError,
} from "../../src/agent/request-accounting.js";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "../../src/agent/context-manager.js";
import { buildContextBreakdown } from "../../src/agent/context-breakdown.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { composeAgentSystemPrompt } from "../../src/agent/prompt-composer.js";
import type {
  ChatMessage,
  ToolDefinition,
} from "../../src/types.js";
import { runAgent } from "../../src/modes/agent.js";
import { deletePlan } from "../../src/store/plan.js";
import type { AgentEvent } from "../../src/agent/events.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const TOOLS: readonly ToolDefinition[] = [
  {
    name: "fs.read",
    wireName: "fs_read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    readOnly: true,
  },
];

const HISTORY: ChatMessage[] = [
  { role: "system", content: "system prompt" },
  { role: "user", content: "first user turn" },
  { role: "assistant", content: "first assistant answer" },
  {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: "call_acc_1",
        name: "fs.read",
        args: { path: "docs/example.md" },
        rawArguments: '{"path":"docs/example.md"}',
      },
    ],
    reasoningBlock: { text: "inspect the file first", signature: "sig" },
  },
  { role: "tool", content: "file contents", toolCallId: "call_acc_1", name: "fs.read" },
  {
    role: "user",
    content: "describe this image",
    images: [
      { mediaType: "image/png", dataBase64: TINY_PNG_BASE64, path: "tiny.png" },
    ],
  },
];

describe("serialized-request accounting service", () => {
  it("matches the legacy breakdown totals exactly (no heuristic drift)", () => {
    const legacy = buildContextBreakdown(HISTORY, [...TOOLS]).estimatedTotalTokens;
    const { accounting } = accountAssembledRequest({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      messages: HISTORY,
      stream: true,
      tools: TOOLS,
    });
    expect(accounting.requestTokens).toBe(legacy);
  });

  it("attributes sections that sum to the whole request with tools", () => {
    const { accounting } = accountAssembledRequest({
      provider: "openai",
      model: "gpt-5.4-mini",
      messages: HISTORY,
      stream: false,
      tools: TOOLS,
    });
    expect(
      accounting.instructionsTokens +
        accounting.historyTokens +
        accounting.liveTokens +
        accounting.toolsTokens,
    ).toBe(accounting.requestTokens);
    expect(accounting.toolsTokens).toBe(
      estimateTextTokens(JSON.stringify(TOOLS)),
    );
    expect(accounting.messageCount).toBe(HISTORY.length);
  });

  it("includes reasoning artifacts, tool calls, and images (MR-004)", () => {
    const plain: ChatMessage = { role: "assistant", content: "answer" };
    const withArtifacts: ChatMessage = {
      ...plain,
      reasoningArtifacts: [
        {
          version: 1,
          kind: "plaintext",
          raw: "thought".repeat(200),
          provenance: { provider: "openai", dialect: "openai-compatible" },
          replay: { scope: "all-history", persistence: "all-turns" },
          position: { sequence: 0, placement: "assistant" },
          accounting: { byteLength: 1400, estimatedTokens: 425 },
        },
      ],
    };
    expect(estimateMessageTokens(withArtifacts)).toBeGreaterThan(
      estimateMessageTokens(plain),
    );
    const { accounting } = accountAssembledRequest({
      provider: "openai",
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "go" }, withArtifacts],
      stream: false,
    });
    expect(accounting.artifactTokens).toBeGreaterThan(0);

    const withImage: ChatMessage = {
      role: "user",
      content: "look",
      images: [
        { mediaType: "image/png", dataBase64: TINY_PNG_BASE64, path: "tiny.png" },
      ],
    };
    const imaged = accountAssembledRequest({
      provider: "openai",
      model: "gpt-5.4-mini",
      messages: [{ role: "user", content: "go" }, withImage],
      stream: false,
    }).accounting;
    expect(imaged.imageCount).toBe(1);
    expect(imaged.imageTokens).toBe(
      estimateImageTokens(withImage.images![0]!),
    );
  });

  it("resolves one effective limit with reserves and headroom", () => {
    const session = resolveEffectiveContextLimit({
      model: "gpt-5.4-mini",
      provider: "openai",
      contextLimitTokens: 100_000,
    });
    expect(session.source).toBe("session-override");
    expect(session.limitTokens).toBe(100_000);
    expect(session.reservedOutputTokens).toBe(24_576);
    expect(session.effectiveSafeTokens).toBe(100_000 - 24_576 - 2_048);

    const small = resolveEffectiveContextLimit({ contextLimitTokens: 20_000 });
    expect(small.reservedOutputTokens).toBe(5_000);
    expect(small.effectiveSafeTokens).toBe(20_000 - 5_000 - 2_048);

    const model = resolveEffectiveContextLimit({
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(model.source).toBe("model-window");
    expect(model.limitTokens).toBeGreaterThan(0);

    expect(resolveEffectiveContextLimit({}).source).toBe("unknown");
    expect(resolveEffectiveContextLimit({}).effectiveSafeTokens).toBeUndefined();
  });

  it("reports headroom and over-limit only against a known limit", () => {
    const base = {
      provider: "openai" as const,
      model: "gpt-5.4-mini",
      messages: HISTORY,
      stream: true,
    };
    const unbounded = accountAssembledRequest(base).accounting;
    expect(unbounded.overLimit).toBe(false);
    expect(unbounded.headroomTokens).toBeGreaterThan(0);

    const bounded = accountAssembledRequest({
      ...base,
      contextLimitTokens: 30_000,
      reservedOutputTokens: 24_576,
      safetyMarginTokens: 2_048,
    }).accounting;
    expect(bounded.limit.effectiveSafeTokens).toBe(30_000 - 24_576 - 2_048);
    expect(bounded.overLimit).toBe(
      bounded.requestTokens > bounded.limit.effectiveSafeTokens!,
    );
    expect(bounded.headroomTokens).toBe(
      bounded.limit.effectiveSafeTokens! - bounded.requestTokens,
    );

    const tiny = accountAssembledRequest({
      ...base,
      contextLimitTokens: 600,
    }).accounting;
    expect(tiny.overLimit).toBe(true);
    expect(tiny.headroomTokens).toBeLessThan(0);
  });

  it("accounts a compiled plan directly with identical totals", () => {
    const plan = compileRequestPlan({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      messages: HISTORY,
      stream: true,
      tools: TOOLS,
    });
    const fromPlan = accountRequestPlan(plan, { provider: "groq", model: "llama-3.3-70b-versatile" });
    const assembled = accountAssembledRequest({
      provider: "groq",
      model: "llama-3.3-70b-versatile",
      messages: HISTORY,
      stream: true,
      tools: TOOLS,
    }).accounting;
    expect(fromPlan.requestTokens).toBe(assembled.requestTokens);
    expect(fromPlan.replayedArtifactCount).toBe(assembled.replayedArtifactCount);
  });
});

describe("one estimator across admission decisions (MR-021)", () => {
  it("keeps context-manager exports as the shared service", () => {
    expect(estimateTokens("hello world!")).toBe(estimateTextTokens("hello world!"));
    expect(estimateMessagesTokens(HISTORY)).toBe(
      HISTORY.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    );
  });

  it("uses the shared estimator for prompt-section admission", () => {
    const composed = composeAgentSystemPrompt({
      mode: "agent",
      nativeToolsActive: true,
      maxTokens: 8,
      sections: [
        { kind: "constitution", content: "constitution", mandatory: true },
        { kind: "focus", content: "FOCUS\n" + "x".repeat(5000), mandatory: false },
      ],
    });
    expect(composed.estimatedTokens).toBe(estimateTextTokens(composed.content));
    expect(composed.omitted).toContain("focus");
    expect(composed.included).toContain("constitution");
  });
});

describe("final pre-dispatch fit validation (MR-007)", () => {
  const stream = vi.fn();
  const complete = vi.fn();

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
      runToolCall: async () => ({ ok: true, output: "tool-output" }),
    };
  });

  vi.mock("../../src/commands/providers.js", async (importActual) => {
    const actual =
      await importActual<typeof import("../../src/commands/providers.js")>();
    return { ...actual, ensureProviderConfigured: async () => {} };
  });

  function bigHistory(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
    for (let index = 0; index < 8; index += 1) {
      messages.push({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ` + "payload ".repeat(6_000),
      });
    }
    return messages;
  }

  function makeSession(id: string) {
    return {
      sessionId: id,
      planApproved: { value: false },
      allow: new Set<string>(),
      pentestAuthorized: { value: false },
    } as never;
  }

  beforeEach(async () => {
    stream.mockReset();
    complete.mockReset();
    await deletePlan("session-over-limit").catch(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the dispatch when the final assembled request cannot fit", async () => {
    stream.mockImplementation(
      (req: { messages?: Array<{ role: string; content: string }> }) => {
        const last = req.messages?.at(-1)?.content.toLowerCase() ?? "";
        if (last.includes("continuation memory")) {
          // Broken summary: compaction rejects it and history stays unchanged.
          return Promise.resolve({
            text: " ",
            provider: "nvidia",
            model: "test-model",
          });
        }
        return Promise.resolve({
          text: "done",
          provider: "nvidia",
          model: "test-model",
        });
      },
    );

    const events: AgentEvent[] = [];
    await expect(
      runAgent("continue", {
        session: makeSession("session-over-limit"),
        history: bigHistory(),
        maxSteps: 3,
        contextLimitTokens: 25_000,
        onEvent: (event) => events.push(event),
      }),
    ).rejects.toThrow(RequestOverLimitError);

    const dispatches = stream.mock.calls.filter(
      ([req]) =>
        !((req as { messages?: Array<{ content: string }> }).messages?.at(-1)?.content ?? "")
          .toLowerCase()
          .includes("continuation memory"),
    );
    expect(dispatches).toHaveLength(0);
    expect(
      events.some(
        (event) =>
          event.type === "turn-error" &&
          event.message.includes("exceeds the effective safe context limit"),
      ),
    ).toBe(true);
  });
});
