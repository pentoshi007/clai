import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, ProviderId } from "../../src/types.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import {
  installTransport,
  isResponsesProbe,
  type FakeTransport,
} from "../conformance/fake-transport.js";
import { textStreamResponse } from "../conformance/wire-fixtures.js";
import { chatCompletion, keySlots, rateLimitedWithoutBackoff } from "../admission/admission-fixtures.js";

let slotsByProvider: Partial<Record<ProviderId, ProviderKeySlot[]>> = {};

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: ProviderId) => ({
      keys: slotsByProvider[provider] ?? [],
      activeIndex: 0,
      source: "storage" as const,
    }),
    getProviderSecret: async (provider: ProviderId) => ({
      value: slotsByProvider[provider]?.[0]?.value ?? "",
      source: "storage" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "nvidia",
      providerFallback: true,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: () => false,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
    getActiveProviderEndpoint: () => "",
    setActiveProviderEndpoint: () => undefined,
    setDefaultProvider: () => undefined,
    setProviderModel: () => undefined,
  };
});

const { completeWithProvider, providers } = await import("../../src/llm/router.js");
const { executeCompactionSummary } = await import(
  "../../src/agent/compaction-executor.js"
);
const { OperationLedger, OperationAdmissionBudgetExceededError, singleAdmissionOperationPolicy } = await import(
  "../../src/llm/operation-ledger.js"
);
const { compactMessagesWithSummary } = await import(
  "../../src/agent/context-manager.js"
);
const { hasOrphanToolMessages } = await import("../../src/agent/tool-history.js");
const { fingerprintFinalRequest } = await import(
  "../../src/llm/request-fingerprint.js"
);

const NVIDIA_MODEL = providers.nvidia.defaultModel;

const USABLE_SUMMARY = [
  "- Goal: prove one-admission automatic compaction.",
  "- Decision: no map/reduce, no retries, no key rotation in auto mode.",
  "- Remaining work: explicit strategies only.",
].join("\n");

function installScript(...steps: Array<() => Response>): FakeTransport {
  let index = 0;
  const transport = installTransport((record) => {
    if (isResponsesProbe(record.url)) {
      transport.generations.pop();
      return new Response("not found", { status: 404 });
    }
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return step();
  });
  return transport;
}

function streamFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamedSummary(text: string): Response {
  return textStreamResponse([
    streamFrame({ choices: [{ index: 0, delta: { content: text } }] }),
    streamFrame({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    "data: [DONE]\n\n",
  ]);
}

function makeSession(id: string) {
  return {
    sessionId: id,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

beforeEach(() => {
  slotsByProvider = {};
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("single-admission compaction executor", () => {
  it("succeeds in exactly one generation with a valid summary", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(() =>
      chatCompletion(USABLE_SUMMARY, NVIDIA_MODEL),
    );
    const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));

    const visible = await executeCompactionSummary({
      provider: "nvidia",
      model: NVIDIA_MODEL,
      systemContent: "summarize",
      prompt: "summarize the history",
      maxTokens: 4096,
      stream: false,
      qualityRetry: false,
      operation: ledger,
    });

    expect(visible).toBe(USABLE_SUMMARY);
    expect(transport.generations).toHaveLength(1);
    expect(ledger.terminalOutcome).toBe("completed");
  });

  it("retries Bynara's opaque 400 with a distinct text-only wire shape", async () => {
    slotsByProvider = { bynara: keySlots(["bynara-test-key"]) };
    const generic =
      "The model rejected this request. It may not support the input you sent (e.g. images on a text-only model) or a parameter is invalid.";
    const transport = installScript(
      () =>
        textStreamResponse([
          streamFrame({ error: { type: "bad_request", message: generic } }),
        ]),
      () => streamedSummary(USABLE_SUMMARY),
    );
    const ledger = new OperationLedger(
      singleAdmissionOperationPolicy("compaction", 2),
    );
    const priorMessages: ChatMessage[] = [
      { role: "system", content: "stable system prompt" },
      {
        role: "user",
        content: "the screenshot was already described in text",
        images: [{ mediaType: "image/png", dataBase64: "bm90LW9uLXRoZS13aXJl" }],
      },
      { role: "assistant", content: "described result" },
    ];

    const visible = await executeCompactionSummary({
      provider: "bynara",
      model: "mimo-v2.5-free",
      systemContent: "summarize",
      prompt: "summarize the history",
      maxTokens: 12_288,
      stream: true,
      qualityRetry: false,
      operation: ledger,
      baseRequest: {
        provider: "bynara",
        model: "mimo-v2.5-free",
        messages: priorMessages,
        thinking: { enabled: true, effort: "high" },
        tools: [
          {
            name: "fs.read",
            wireName: "fs_read",
            description: "read a file",
            parameters: { type: "object", properties: {} },
          },
        ],
        toolChoice: "auto",
        parallelToolCalls: true,
      },
      history: priorMessages,
    });

    expect(visible).toBe(USABLE_SUMMARY);
    expect(transport.generations).toHaveLength(2);
    const first = transport.generations[0]!.body as Record<string, unknown>;
    const second = transport.generations[1]!.body as Record<string, unknown>;
    expect(JSON.stringify(first)).not.toContain("image_url");
    expect(JSON.stringify(first)).not.toContain("bm90LW9uLXRoZS13aXJl");
    expect(first.tools).toBeDefined();
    expect(first.tool_choice).toBe("auto");
    expect(first.max_tokens).toBeGreaterThanOrEqual(12_288);
    expect(JSON.stringify(second)).not.toContain("image_url");
    expect(second.tools).toBeUndefined();
    expect(second.tool_choice).toBeUndefined();
    expect(second.parallel_tool_calls).toBeUndefined();
    expect(second.max_tokens).toBe(12_288);
    expect(second).not.toEqual(first);
    expect(ledger.admissionsUsed).toBe(2);
    expect(ledger.terminalOutcome).toBe("completed");
  });

  it("caps key rotation at one generation on a rate-limited route", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a", "nvapi-b"]) };
    const transport = installScript(rateLimitedWithoutBackoff);
    const ledger = new OperationLedger(singleAdmissionOperationPolicy("compaction"));

    // The route is pinned, so the second key is never attempted and the guard is
    // never reached: the caller sees the rate limit it can actually act on.
    await expect(
      executeCompactionSummary({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        systemContent: "summarize",
        prompt: "summarize the history",
        maxTokens: 4096,
        stream: false,
        qualityRetry: false,
        operation: ledger,
      }),
    ).rejects.not.toBeInstanceOf(OperationAdmissionBudgetExceededError);

    expect(transport.generations).toHaveLength(1);
    expect(ledger.admissionsUsed).toBe(1);
    expect(ledger.admissionRefused).toBe(false);
    expect(ledger.terminalOutcome).toBe("failed");
  });

  it("does not quality-retry a truncated summary", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(() =>
      chatCompletion("- Goal: partial summary that hit", NVIDIA_MODEL, "length"),
    );

    await expect(
      executeCompactionSummary({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        systemContent: "summarize",
        prompt: "summarize the history",
        maxTokens: 4096,
        stream: false,
        qualityRetry: false,
      }),
    ).rejects.toThrow(/summary output limit/i);

    expect(transport.generations).toHaveLength(1);
  });

  it("does not server-retry a 5xx in automatic mode", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(() =>
      new Response(JSON.stringify({ error: { message: "upstream is down" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      executeCompactionSummary({
        provider: "nvidia",
        model: NVIDIA_MODEL,
        systemContent: "summarize",
        prompt: "summarize the history",
        maxTokens: 4096,
        stream: false,
        qualityRetry: false,
      }),
    ).rejects.toThrow(/upstream is down|server error/i);

    expect(transport.generations).toHaveLength(1);
  });

  it("preserves the serialized history prefix of the prior request", async () => {
    slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
    const transport = installScript(() =>
      chatCompletion(USABLE_SUMMARY, NVIDIA_MODEL),
    );
    const priorMessages = [
      { role: "system", content: "stable system prompt" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second user turn" },
    ];

    const tools = [
      {
        name: "fs.read",
        wireName: "fs_read",
        description: "read a file",
        parameters: {
          type: "object" as const,
          properties: { path: { type: "string" } },
        },
      },
    ];

    await executeCompactionSummary({
      provider: "nvidia",
      model: NVIDIA_MODEL,
      systemContent: "summarize",
      prompt: "summarize the entire conversation above this instruction",
      maxTokens: 12_288,
      stream: false,
      qualityRetry: false,
      baseRequest: {
        provider: "nvidia",
        model: NVIDIA_MODEL,
        messages: priorMessages,
        temperature: 0.6,
        thinking: { enabled: true, effort: "high" },
        tools,
        toolChoice: "auto",
        parallelToolCalls: true,
      },
      history: priorMessages,
    });

    const recordedBody = transport.generations[0]!.body;
    const compactionBodyText =
      typeof recordedBody === "string"
        ? recordedBody
        : JSON.stringify(recordedBody);
    const compactionBody = JSON.parse(compactionBodyText) as Record<string, unknown> & {
      model: string;
      max_tokens: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(compactionBody.messages).toHaveLength(priorMessages.length + 1);

    const priorBodyText = JSON.stringify({
      ...compactionBody,
      messages: compactionBody.messages.slice(0, priorMessages.length),
    });
    const priorFingerprint = fingerprintFinalRequest(
      { provider: "nvidia", model: NVIDIA_MODEL },
      priorBodyText,
    )!;
    const compactionFingerprint = fingerprintFinalRequest(
      { provider: "nvidia", model: NVIDIA_MODEL },
      compactionBodyText,
    )!;

    const historyPrefixAt = (
      fingerprint: typeof priorFingerprint,
      historyItems: number,
    ) =>
      fingerprint.prefixes.find(
        (prefix) =>
          prefix.section === "history" &&
          prefix.boundary === "history-item" &&
          prefix.historyItems === historyItems,
      );
    for (let items = 1; items <= priorMessages.length; items += 1) {
      expect(historyPrefixAt(priorFingerprint, items)?.sha256).toBe(
        historyPrefixAt(compactionFingerprint, items)?.sha256,
      );
    }
    const section = (
      fingerprint: typeof priorFingerprint,
      name: "tools" | "settings",
    ) => fingerprint.sections.find((candidate) => candidate.section === name);
    expect(section(compactionFingerprint, "tools")?.sha256).toBe(
      section(priorFingerprint, "tools")?.sha256,
    );
    expect(section(compactionFingerprint, "settings")?.sha256).toBe(
      section(priorFingerprint, "settings")?.sha256,
    );
    expect(compactionBody.max_tokens).toBeGreaterThanOrEqual(12_288);
    expect(compactionBody.temperature).toBe(0.6);
    expect(compactionBody.tool_choice).toBe("auto");
    expect(compactionBody.tools).toBeDefined();
    expect(priorFingerprint.body.sha256).not.toBe(
      compactionFingerprint.body.sha256,
    );
  });
});

describe("single-admission chunking strategies", () => {
  function largeHistory(): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: "system prompt" }];
    for (let index = 0; index < 10; index += 1) {
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

  it("uses the direct strategy when the source fits one pass", async () => {
    const stages: Array<string | undefined> = [];
    const result = await compactMessagesWithSummary(
      largeHistory(),
      async (prompt, stage) => {
        stages.push(stage?.phase);
        expect(prompt).toContain("continuation memory");
        return USABLE_SUMMARY;
      },
      { budgetTokens: 0, keepRecent: 2, singleAdmission: true, singlePassInputBudgetTokens: 1_000_000 },
    );

    expect(stages).toEqual(["single"]);
    expect(result.strategy).toBe("direct");
    expect(result.summarized).toBe(true);
  });

  it("forces the direct single pass when a cache-preserving replay was pre-planned", async () => {
    const calls: Array<{ phase: string | undefined; hasSource: boolean }> = [];
    const result = await compactMessagesWithSummary(
      largeHistory(),
      async (prompt, stage) => {
        calls.push({
          phase: stage?.phase,
          hasSource: Boolean(stage?.sourceMessages?.length),
        });
        // The direct prompt treats the conversation itself as the material.
        expect(prompt).toContain("entire conversation above this instruction");
        return USABLE_SUMMARY;
      },
      {
        budgetTokens: 0,
        keepRecent: 2,
        singleAdmission: true,
        // Zero budget would normally reject the direct pass and fall through
        // to emergency slicing; a pre-flighted replay plan overrides the gate.
        singlePassInputBudgetTokens: 0,
        forceDirectSinglePass: true,
      },
    );

    expect(result.strategy).toBe("direct");
    expect(calls).toEqual([{ phase: "single", hasSource: true }]);
    expect(result.summarized).toBe(true);
  });

  it("slices the oldest range in one dispatch instead of map/reduce", async () => {
    const calls: Array<{ phase: string; transcriptChars: number }> = [];
    const result = await compactMessagesWithSummary(
      largeHistory(),
      async (prompt, stage) => {
        calls.push({
          phase: stage?.phase ?? "none",
          transcriptChars: prompt.length,
        });
        return USABLE_SUMMARY;
      },
      { budgetTokens: 0, keepRecent: 2, singleAdmission: true, singlePassInputBudgetTokens: 0 },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.phase).toBe("single");
    expect(result.strategy).toBe("emergency_prefix_slice");
    expect(result.summarized).toBe(true);
    expect(hasOrphanToolMessages([...result.messages])).toBe(false);
    const memory = result.messages.find(
      (message) => message.role === "system" && message.content.includes("Session memory"),
    );
    expect(memory?.content).toContain(USABLE_SUMMARY);
    const remainingUserTurns = result.messages.filter(
      (message) => message.role === "user",
    );
    expect(remainingUserTurns.length).toBeGreaterThan(2);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it("fans out map/reduce only when single admission is not required", async () => {
    const stages: string[] = [];
    await compactMessagesWithSummary(
      largeHistory(),
      async (prompt, stage) => {
        stages.push(stage?.phase ?? "none");
        return USABLE_SUMMARY;
      },
      { budgetTokens: 0, keepRecent: 2, singlePassInputBudgetTokens: 0 },
    );

    expect(stages.length).toBeGreaterThan(2);
    expect(stages.filter((stage) => stage === "map").length).toBeGreaterThan(1);
    expect(stages).toContain("reduce");
  });

  it("rejects single-admission slicing of a visual transcript locally", async () => {
    let dispatches = 0;
    await expect(
      compactMessagesWithSummary(
        largeHistory(),
        async () => {
          dispatches += 1;
          return USABLE_SUMMARY;
        },
        { budgetTokens: 0, keepRecent: 2, singleAdmission: true, singlePassInputBudgetTokens: 0 },
        "visual transcript ".repeat(20_000),
      ),
    ).rejects.toThrow(/single-admission compaction cannot slice/i);

    expect(dispatches).toBe(0);
  });
});
