import { describe, expect, it } from "vitest";

import { buildContextBreakdown } from "../../src/agent/context-breakdown.js";
import {
  estimateMessagesTokens,
  estimateTokens,
} from "../../src/agent/context-manager.js";
import { reasoningArtifactTokensForMessage } from "../../src/llm/reasoning-artifacts.js";
import {
  compactedUsageSnapshot,
  estimatedContextSnapshot,
  estimatedUsageSnapshot,
  resolveContextUsageSnapshot,
  type ContextUsageTarget,
} from "../../src/app/controllers/session-context-usage.js";
import { parseMetaUsage } from "../../src/llm/meta.js";
import { createContextSnapshot } from "../../src/llm/context-snapshot.js";
import {
  applyUsageToSnapshot,
  formatContextChip,
  mergeAnthropicStreamUsage,
  normalizeTokenUsage,
  parseAnthropicUsage,
  parseFireworksUsage,
  parseGeminiUsage,
  parseOpenAiUsage,
  snapshotFromEstimate,
  type ContextUsageSnapshot,
} from "../../src/llm/token-usage.js";
import type { ChatMessage } from "../../src/types.js";
import {
  anthropicUsagePayload,
  buildSessionFixture,
  geminiUsagePayload,
  openAiUsagePayload,
  textOfTokens,
} from "./context-fixtures.js";

const HISTORY_TOKENS = 68_000;
const SYSTEM_TOKENS = 24_000;
const TOOL_SCHEMA_TOKENS = 12_000;
const REASONING_ARTIFACT_TOKENS = 16_000;
const EXACT_PROMPT_TOKENS =
  HISTORY_TOKENS + SYSTEM_TOKENS + TOOL_SCHEMA_TOKENS + REASONING_ARTIFACT_TOKENS;

const CONTEXT_LIMIT = 1_000_000;
const MODEL = "claude-sonnet-4.6";

const SNAPSHOT_FIELDS = [
  "contextLimit",
  "contextTokens",
  "exact",
  "lastCompletionTokens",
  "sessionCompletionTokens",
  "sessionPromptTokens",
];

const fixture = buildSessionFixture({
  historyTokens: HISTORY_TOKENS,
  systemTokens: SYSTEM_TOKENS,
  toolSchemaTokens: TOOL_SCHEMA_TOKENS,
  reasoningTokens: REASONING_ARTIFACT_TOKENS,
});

const target: ContextUsageTarget = {
  provider: "anthropic",
  model: MODEL,
  contextLimitTokens: CONTEXT_LIMIT,
};

function exactSnapshot(promptTokens = EXACT_PROMPT_TOKENS): ContextUsageSnapshot {
  const usage = parseOpenAiUsage(
    openAiUsagePayload({
      promptTokens,
      completionTokens: 900,
      cachedTokens: 96_000,
      reasoningTokens: 640,
    }),
  )!;
  return applyUsageToSnapshot(undefined, usage, CONTEXT_LIMIT);
}

describe("composer chip versus compaction card scope", () => {
  it("reproduces a 120k composer number against an 84k compaction number", () => {
    const chipSnapshot = exactSnapshot();
    const cardBeforeTokens = estimateMessagesTokens(fixture.historySlice);

    expect(chipSnapshot.contextTokens).toBe(120_000);
    expect(cardBeforeTokens).toBe(84_000);
    expect(formatContextChip(chipSnapshot, { compact: true })).toBe(
      "ctx:120k/1M 12%",
    );
  });

  it("attributes the remaining gap to excluded system sections and tools", () => {
    const cardBeforeTokens = estimateMessagesTokens(fixture.historySlice);
    const excludedSystemTokens = estimateMessagesTokens(fixture.systemMessages);
    const breakdown = buildContextBreakdown(fixture.fullMessages, fixture.tools);
    const artifactMessage = fixture.historySlice.find(
      (message) => message.reasoningArtifacts?.length,
    );
    expect(artifactMessage).toBeDefined();
    const reasoningArtifactTokens = reasoningArtifactTokensForMessage(
      artifactMessage!,
    );
    const assistantTextTokens = fixture.historySlice
      .filter((message) => message.role === "assistant")
      .reduce(
        (sum, message) => sum + estimateTokens(message.content) + 4,
        0,
      );

    expect(excludedSystemTokens).toBe(SYSTEM_TOKENS);
    expect(breakdown.toolSchemaTokens).toBe(TOOL_SCHEMA_TOKENS);
    expect(reasoningArtifactTokens).toBe(REASONING_ARTIFACT_TOKENS);
    expect(breakdown.assistantTokens).toBe(
      assistantTextTokens + reasoningArtifactTokens,
    );
    expect(breakdown.estimatedTotalTokens).toBe(
      cardBeforeTokens + excludedSystemTokens + TOOL_SCHEMA_TOKENS,
    );
    expect(EXACT_PROMPT_TOKENS - cardBeforeTokens).toBe(
      excludedSystemTokens + TOOL_SCHEMA_TOKENS,
    );
    expect(EXACT_PROMPT_TOKENS - cardBeforeTokens).toBe(36_000);
  });

  it("labels the excluded system sections in the breakdown", () => {
    const breakdown = buildContextBreakdown(fixture.fullMessages, fixture.tools);
    const parts = breakdown.systemParts;

    expect(parts.constitutionTokens).toBeGreaterThan(0);
    expect(parts.planTokens).toBeGreaterThan(0);
    expect(parts.sessionStateTokens).toBeGreaterThan(0);
    expect(
      parts.constitutionTokens + parts.planTokens + parts.sessionStateTokens,
    ).toBe(breakdown.systemTokens);
  });

  it("keeps the legacy renderer projection frozen at six fields", () => {
    const chipSnapshot = exactSnapshot();
    const cardSnapshot = snapshotFromEstimate(
      fixture.historySlice,
      MODEL,
      "anthropic",
    );

    expect(Object.keys(chipSnapshot).sort()).toEqual(SNAPSHOT_FIELDS);
    expect(Object.keys(cardSnapshot).sort()).toEqual(SNAPSHOT_FIELDS);
    expect(chipSnapshot.exact).toBe(true);
    expect(cardSnapshot.exact).toBe(false);
  });
});

describe("reasoning replay contributes to the context estimate", () => {
  it("counts a large canonical reasoning artifact once", () => {
    const withArtifact = fixture.historySlice;
    const withoutArtifact: ChatMessage[] = withArtifact.map(
      ({ reasoningBlock: _reasoningBlock, reasoningArtifacts: _artifacts, ...rest }) =>
        rest,
    );

    expect(estimateMessagesTokens(withArtifact)).toBe(84_000);
    expect(estimateMessagesTokens(withoutArtifact)).toBe(HISTORY_TOKENS);
    expect(
      estimateMessagesTokens(withArtifact) - estimateMessagesTokens(withoutArtifact),
    ).toBe(REASONING_ARTIFACT_TOKENS);
  });
});

describe("cache and reasoning bucket normalization", () => {
  it("normalizes compatible cache and reasoning buckets while preserving the legacy projection", () => {
    const usage = parseOpenAiUsage(
      openAiUsagePayload({
        promptTokens: 120_000,
        completionTokens: 900,
        cachedTokens: 96_000,
        reasoningTokens: 640,
      }),
    )!;

    expect(usage.cachedPromptTokens).toBe(96_000);
    expect(usage.reasoningTokens).toBe(640);

    const snapshot = applyUsageToSnapshot(undefined, usage, CONTEXT_LIMIT);
    expect(Object.keys(snapshot).sort()).toEqual(SNAPSHOT_FIELDS);
    expect(formatContextChip(snapshot, { compact: true })).not.toContain("96k");
  });

  it("normalizes Gemini cached and thought counters", () => {
    const usage = parseGeminiUsage(
      geminiUsagePayload({
        promptTokens: 120_000,
        completionTokens: 900,
        cachedTokens: 96_000,
        thoughtsTokens: 640,
      }),
    )!;

    expect(usage.promptTokens).toBe(120_000);
    expect(usage.cachedPromptTokens).toBe(96_000);
    expect(usage.reasoningTokens).toBe(640);
  });

  it("keeps Anthropic cache buckets in usage and across streamed frames", () => {
    const start = parseAnthropicUsage(
      anthropicUsagePayload({
        inputTokens: 4_000,
        outputTokens: 0,
        cacheReadTokens: 96_000,
        cacheCreationTokens: 20_000,
      }),
    )!;
    const delta = normalizeTokenUsage({ completionTokens: 900, exact: true })!;

    const merged = mergeAnthropicStreamUsage(start, delta);

    expect(start.promptTokens).toBe(120_000);
    expect(start.cachedPromptTokens).toBe(96_000);
    expect(start.cacheCreationTokens).toBe(20_000);
    expect(merged.promptTokens).toBe(120_000);
    expect(merged.completionTokens).toBe(900);
    expect(merged.cachedPromptTokens).toBe(96_000);
    expect(merged.cacheCreationTokens).toBe(20_000);
  });

  it("normalizes direct DeepSeek hit/miss and Fireworks performance telemetry", () => {
    const deepSeek = parseOpenAiUsage({
      prompt_tokens: 120_000,
      completion_tokens: 900,
      prompt_cache_hit_tokens: 96_000,
      prompt_cache_miss_tokens: 24_000,
      completion_tokens_details: { reasoning_tokens: 640 },
    })!;
    expect(deepSeek).toMatchObject({
      cachedPromptTokens: 96_000,
      uncachedPromptTokens: 24_000,
      reasoningTokens: 640,
    });

    const fireworks = parseFireworksUsage(
      { completion_tokens: 900 },
      {
        "prompt-tokens": 120_000,
        "cached-prompt-tokens": 96_000,
      },
      new Headers([
        ["fireworks-prompt-tokens", "120000"],
        ["fireworks-cached-prompt-tokens", "96000"],
      ]),
    )!;
    expect(fireworks).toMatchObject({
      promptTokens: 120_000,
      cachedPromptTokens: 96_000,
      uncachedPromptTokens: 24_000,
      completionTokens: 900,
    });
  });

  it("normalizes Meta cache and reasoning fields without exposing response content", () => {
    const usage = parseMetaUsage({
      input_tokens: 120_000,
      output_tokens: 900,
      total_tokens: 120_900,
      input_tokens_details: { cached_tokens: 96_000 },
      output_tokens_details: { reasoning_tokens: 640 },
    })!;

    expect(usage).toMatchObject({
      promptTokens: 120_000,
      cachedPromptTokens: 96_000,
      reasoningTokens: 640,
    });
  });
});

describe("exactness lifetime", () => {
  it("demotes a prior exact context count when a later attempt omits prompt tokens", () => {
    const previous = exactSnapshot();
    const promptless = normalizeTokenUsage({
      completionTokens: 50,
      exact: true,
    })!;

    const next = applyUsageToSnapshot(previous, promptless, CONTEXT_LIMIT);

    expect(promptless.promptTokens).toBe(0);
    expect(promptless.promptTokensKnown).toBe(false);
    expect(next.contextTokens).toBe(120_000);
    expect(next.exact).toBe(false);
  });

  it("does not retain a legacy unknown-scope exact count after history grows", () => {
    const previous = exactSnapshot();
    const grown: ChatMessage[] = [
      ...fixture.fullMessages,
      { role: "user", content: textOfTokens(150_000) },
    ];

    const resolved = resolveContextUsageSnapshot(target, grown, previous)!;

    expect(estimateMessagesTokens(grown)).toBeGreaterThan(240_000);
    expect(resolved.contextTokens).toBe(estimateMessagesTokens(grown));
    expect(resolved.exact).toBe(false);
  });

  it("replaces an exact snapshot with a newer assembled-request estimate", () => {
    const previous = exactSnapshot();

    const refreshed = estimatedUsageSnapshot(target, previous, 250_000)!;

    expect(refreshed.contextTokens).toBe(250_000);
    expect(refreshed.exact).toBe(false);
  });

  it("replaces a provider-exact snapshot with a newer assembled-request estimate", () => {
    const previous = createContextSnapshot({
      contextTokens: 78_200,
      lastCompletionTokens: 100,
      sessionPromptTokens: 78_200,
      sessionCompletionTokens: 100,
      scope: "provider-request",
      precision: "provider-exact",
      limit: { source: "session-override", tokens: 300_000 },
      observedAt: 1,
    });

    const refreshed = estimatedContextSnapshot(
      { ...target, contextLimitTokens: 300_000 },
      previous,
      229_182,
      () => 2,
    );

    expect(refreshed).toMatchObject({
      contextTokens: 229_182,
      scope: "assembled-request",
      precision: "estimate",
      observedAt: 2,
    });
  });

  it("demotes to an estimate after compaction", () => {
    const previous = exactSnapshot();

    const compacted = compactedUsageSnapshot(
      target,
      previous,
      fixture.historySlice,
      18_000,
    );

    expect(compacted.contextTokens).toBe(18_000);
    expect(compacted.exact).toBe(false);
    expect(compacted.sessionPromptTokens).toBe(previous.sessionPromptTokens);
  });
});
