import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatMessage, CompletionRequest, ProviderId } from "../../src/types.js";
import type { ProviderKeySlot } from "../../src/store/keys.js";
import { installTransport, type FakeTransport } from "../conformance/fake-transport.js";
import {
  chatCompletion,
  contextTooLarge,
  keySlots,
  rateLimitedWithoutBackoff,
  upstreamUnavailable,
} from "./admission-fixtures.js";

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
const {
  DEFAULT_STREAM_RECOVERY_LIMITS,
  createStreamRecoveryState,
  planStreamRecovery,
  recordRecoveryAttempt,
} = await import("../../src/agent/stream-recovery.js");
const { compactMessagesWithSummary } = await import(
  "../../src/agent/context-manager.js"
);
const {
  buildCompactionRetryPrompt,
  isCompactionCompletionTruncated,
  looksLikeIncompleteCompactionSummary,
  normalizeCompactionSummary,
} = await import("../../src/agent/compaction-summary.js");

const MODEL = providers.nvidia.defaultModel;
const NO_WAIT_LIMITS = { ...DEFAULT_STREAM_RECOVERY_LIMITS, maxDelayMs: 0 };
const SUMMARY_MAX_TOKENS = 4096;

const USABLE_SUMMARY = [
  "- Goal: keep the admission baseline reproducible.",
  "- Decision: fixtures assert generation requests, not router iterations.",
  "- Remaining work: replace per-layer caps with one ledger.",
].join("\n");

const UNUSABLE_SUMMARY = "- Goal: keep the baseline reproducible and";

function installScript(...steps: Array<() => Response>): FakeTransport {
  let index = 0;
  return installTransport(() => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    return step();
  });
}

async function runTurnWithRecovery(
  request: CompletionRequest,
  maxRetries?: number,
): Promise<{ attempts: number }> {
  const state = createStreamRecoveryState();
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      await completeWithProvider(
        request,
        maxRetries === undefined ? {} : { maxRetries },
      );
      return { attempts };
    } catch (error) {
      const plan = planStreamRecovery({ error, state, limits: NO_WAIT_LIMITS });
      if (plan.action === "give-up") return { attempts };
      recordRecoveryAttempt(state, plan.kind);
    }
  }
}

async function summarizeThroughRouter(prompt: string): Promise<string> {
  const completion = await completeWithProvider(
    {
      provider: "nvidia",
      messages: [{ role: "user", content: prompt }],
      maxTokens: SUMMARY_MAX_TOKENS,
    },
    { maxRetries: 0 },
  );
  return completion.text;
}

function longTranscript(): ChatMessage[] {
  const paragraph = (index: number): string =>
    Array.from(
      { length: 60 },
      (_unused, line) =>
        `step ${index}.${line}: inspected src/module-${index}-${line}.ts and recorded the observed behavior for the baseline.`,
    ).join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: "baseline system prompt" },
  ];
  for (let index = 0; index < 12; index += 1) {
    messages.push({ role: "user", content: `request ${index}` });
    messages.push({ role: "assistant", content: paragraph(index) });
  }
  return messages;
}

beforeEach(() => {
  slotsByProvider = { nvidia: keySlots(["nvapi-a"]) };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recovery ladder admissions", () => {
  it("spends one admission per recovery attempt on a capacity failure", async () => {
    const transport = installScript(upstreamUnavailable);

    const { attempts } = await runTurnWithRecovery(
      { provider: "nvidia", messages: [{ role: "user", content: "hi" }] },
      0,
    );

    expect(attempts).toBe(4);
    expect(transport.generations).toHaveLength(4);
  });

  it("spends one admission per compaction retry on context overflow", async () => {
    const transport = installScript(contextTooLarge);

    const { attempts } = await runTurnWithRecovery(
      { provider: "nvidia", messages: [{ role: "user", content: "hi" }] },
      0,
    );

    expect(attempts).toBe(3);
    expect(transport.generations).toHaveLength(3);
  });

  it("multiplies the router retry budget by the recovery budget", async () => {
    const transport = installScript(rateLimitedWithoutBackoff);

    const { attempts } = await runTurnWithRecovery({
      provider: "nvidia",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(attempts).toBe(4);
    expect(transport.generations).toHaveLength(28);
  });
});

describe("compaction fan-out admissions", () => {
  it("spends one admission per map chunk plus one for the reduce stage", async () => {
    const transport = installScript(() => chatCompletion(USABLE_SUMMARY, MODEL));
    const stages: string[] = [];

    const result = await compactMessagesWithSummary(
      longTranscript(),
      async (prompt, stage) => {
        stages.push(`${stage?.phase ?? "single"}:${stage?.index ?? 0}`);
        return summarizeThroughRouter(prompt);
      },
      { budgetTokens: 0, keepRecent: 2 },
    );

    expect(result.summarized).toBe(true);
    expect(stages.filter((stage) => stage.startsWith("map"))).toHaveLength(2);
    expect(stages.filter((stage) => stage.startsWith("reduce"))).toHaveLength(1);
    expect(transport.generations).toHaveLength(3);
  });

  it("bills every map admission even when the summary is rejected", async () => {
    const transport = installScript(() => chatCompletion(UNUSABLE_SUMMARY, MODEL));
    const original = longTranscript();
    const snapshot = JSON.stringify(original);

    await expect(
      compactMessagesWithSummary(original, summarizeThroughRouter, {
        budgetTokens: 0,
        keepRecent: 2,
      }),
    ).rejects.toThrow(/incomplete summary/i);

    expect(transport.generations).toHaveLength(2);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("doubles every compaction stage when the quality retry fires", async () => {
    const transport = installTransport((request) =>
      JSON.stringify(request.body).includes("QUALITY RETRY")
        ? chatCompletion(USABLE_SUMMARY, MODEL, "stop")
        : chatCompletion(UNUSABLE_SUMMARY, MODEL, "length"),
    );

    const result = await compactMessagesWithSummary(
      longTranscript(),
      async (prompt) => {
        const first = await completeWithProvider(
          {
            provider: "nvidia",
            messages: [{ role: "user", content: prompt }],
            maxTokens: SUMMARY_MAX_TOKENS,
          },
          { maxRetries: 0 },
        );
        const visible = normalizeCompactionSummary(first.text);
        const unusable =
          isCompactionCompletionTruncated(first, SUMMARY_MAX_TOKENS) ||
          !visible ||
          looksLikeIncompleteCompactionSummary(visible);
        if (!unusable) return first.text;
        return summarizeThroughRouter(
          buildCompactionRetryPrompt(prompt, "truncated"),
        );
      },
      { budgetTokens: 0, keepRecent: 2 },
    );

    expect(result.summarized).toBe(true);
    expect(transport.generations).toHaveLength(6);
  });
});
