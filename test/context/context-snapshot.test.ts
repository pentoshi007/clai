import { describe, expect, it } from "vitest";

import {
  contextAttemptFromOperationUsage,
  isContextSnapshotV1,
  toLegacyContextUsage,
} from "../../src/llm/context-snapshot.js";
import type { OperationUsageSnapshot } from "../../src/llm/operation-usage.js";
import {
  compactedContextSnapshot,
  estimatedContextSnapshot,
  recordContextUsageSnapshot,
  restoredContextSnapshot,
  type ContextUsageTarget,
} from "../../src/app/controllers/session-context-usage.js";
import { persistedContextUsage } from "../../src/app/controllers/session-persistence.js";
import type { TokenUsage } from "../../src/types.js";

const target: ContextUsageTarget = {
  provider: "openai",
  model: "gpt-test",
  contextLimitTokens: 1_000,
};

const usage: TokenUsage = {
  promptTokens: 600,
  completionTokens: 50,
  totalTokens: 650,
  exact: true,
  cachedPromptTokens: 400,
  cacheCreationTokens: 20,
  uncachedPromptTokens: 180,
  reasoningTokens: 30,
};

const operationUsage: OperationUsageSnapshot = {
  attempts: [
    {
      sequence: 7,
      provider: "openai",
      model: "gpt-test",
      mode: "stream",
      reason: "initial",
      outcome: "success",
      usage: { kind: "known", value: usage },
    },
  ],
  aggregate: {
    status: "known",
    knownAdmissions: 1,
    unknownAdmissions: 0,
    usage,
  },
};

describe("ContextSnapshotV1", () => {
  it("records provider cache/reasoning telemetry and projects the frozen legacy shape", () => {
    const attempt = contextAttemptFromOperationUsage(operationUsage);
    const snapshot = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      attempt,
      () => 1_700_000_000_000,
    );

    expect(snapshot).toEqual({
      version: 1,
      contextTokens: 600,
      lastCompletionTokens: 50,
      sessionPromptTokens: 600,
      sessionCompletionTokens: 50,
      scope: "provider-request",
      precision: "provider-exact",
      limit: { source: "session-override", tokens: 1_000 },
      headroom: { kind: "known", remainingTokens: 400 },
      cache: {
        kind: "reported",
        readTokens: 400,
        creationTokens: 20,
        uncachedTokens: 180,
      },
      reasoning: { kind: "reported", outputTokens: 30 },
      attempt: {
        kind: "generation",
        sequence: 7,
        provider: "openai",
        model: "gpt-test",
        mode: "stream",
        reason: "initial",
        outcome: "success",
      },
      observedAt: 1_700_000_000_000,
    });
    expect(toLegacyContextUsage(snapshot)).toEqual({
      contextTokens: 600,
      contextLimit: 1_000,
      lastCompletionTokens: 50,
      sessionPromptTokens: 600,
      sessionCompletionTokens: 50,
      exact: true,
    });
    expect(isContextSnapshotV1(snapshot)).toBe(true);
    expect(isContextSnapshotV1({ ...snapshot, attempt: undefined })).toBe(false);
  });

  it("preserves explicitly reported zero counters instead of treating them as unknown", () => {
    const zeroUsage: TokenUsage = {
      promptTokens: 600,
      completionTokens: 0,
      totalTokens: 600,
      exact: true,
      cachedPromptTokens: 0,
      cacheCreationTokens: 0,
      uncachedPromptTokens: 0,
      reasoningTokens: 0,
    };
    const snapshot = recordContextUsageSnapshot(
      target,
      undefined,
      zeroUsage,
      undefined,
      () => 1,
    );

    expect(snapshot.cache).toEqual({
      kind: "reported",
      readTokens: 0,
      creationTokens: 0,
      uncachedTokens: 0,
    });
    expect(snapshot.reasoning).toEqual({ kind: "reported", outputTokens: 0 });
  });

  it("uses the same schema for manual and automatic compaction scopes", () => {
    const current = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      contextAttemptFromOperationUsage(operationUsage),
      () => 1,
    );
    const manual = compactedContextSnapshot(
      target,
      current,
      [],
      320,
      "message-history",
      () => 2,
    );
    const automatic = compactedContextSnapshot(
      target,
      current,
      [],
      320,
      "assembled-request",
      () => 3,
    );

    expect(manual).toMatchObject({
      version: 1,
      contextTokens: 320,
      scope: "message-history",
      precision: "estimate",
      limit: { source: "session-override", tokens: 1_000 },
      headroom: { kind: "unknown" },
      cache: { kind: "unknown" },
      reasoning: { kind: "unknown" },
      attempt: { kind: "unavailable" },
      observedAt: 2,
    });
    expect(automatic).toMatchObject({
      version: 1,
      contextTokens: 320,
      scope: "assembled-request",
      precision: "estimate",
      headroom: { kind: "known", remainingTokens: 680 },
      cache: { kind: "unknown" },
      reasoning: { kind: "unknown" },
      attempt: { kind: "unavailable" },
      observedAt: 3,
    });
  });

  it("persists V1 additively, honors a live limit on restore, and migrates old records", () => {
    const snapshot = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      contextAttemptFromOperationUsage(operationUsage),
      () => 100,
    );
    const persisted = persistedContextUsage(snapshot)!;

    expect(persisted).toMatchObject({
      ...toLegacyContextUsage(snapshot),
      contextSnapshot: snapshot,
    });

    const restored = restoredContextSnapshot(
      { ...target, contextLimitTokens: 800 },
      persisted,
      () => 999,
    )!;
    expect(restored).toMatchObject({
      scope: "provider-request",
      precision: "provider-exact",
      limit: { source: "session-override", tokens: 800 },
      headroom: { kind: "known", remainingTokens: 200 },
      cache: {
        kind: "reported",
        readTokens: 400,
        creationTokens: 20,
        uncachedTokens: 180,
      },
      reasoning: { kind: "reported", outputTokens: 30 },
      observedAt: 100,
    });

    const migrated = restoredContextSnapshot(
      target,
      {
        contextTokens: 275,
        contextLimit: 999_999,
        lastCompletionTokens: 10,
        sessionPromptTokens: 1_200,
        sessionCompletionTokens: 300,
        exact: true,
      },
      () => 123,
    )!;
    expect(migrated).toMatchObject({
      version: 1,
      contextTokens: 275,
      scope: "unknown",
      precision: "provider-exact",
      limit: { source: "session-override", tokens: 1_000 },
      headroom: { kind: "unknown" },
      cache: { kind: "unknown" },
      reasoning: { kind: "unknown" },
      attempt: { kind: "unavailable" },
      observedAt: 123,
    });
  });

  it("keeps a provider-measured count until a newer provider measurement", () => {
    const current = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      undefined,
      () => 1,
    );
    const inFlight = estimatedContextSnapshot(target, current, 720, () => 2);
    const completed = recordContextUsageSnapshot(
      target,
      inFlight,
      { ...usage, promptTokens: 640, totalTokens: 690 },
      undefined,
      () => 3,
    );

    expect(inFlight).toMatchObject({
      contextTokens: 600,
      scope: "provider-request",
      precision: "provider-exact",
      observedAt: 1,
    });
    expect(completed).toMatchObject({
      contextTokens: 640,
      scope: "provider-request",
      precision: "provider-exact",
      observedAt: 3,
    });
  });

  it("does not let a manual estimate override provider-reported context usage", () => {
    const providerSnapshot = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      undefined,
      () => 1,
    );
    const inflated = estimatedContextSnapshot(
      target,
      providerSnapshot,
      298_000,
      () => 2,
    );
    expect(inflated).toMatchObject({
      contextTokens: 600,
      scope: "provider-request",
      precision: "provider-exact",
      observedAt: 1,
    });
    const usageKnown = recordContextUsageSnapshot(
      target,
      inflated,
      { ...usage, promptTokens: 219_000, totalTokens: 219_100 },
      undefined,
      () => 3,
    );
    expect(usageKnown).toMatchObject({
      contextTokens: 219_000,
      scope: "provider-request",
      precision: "provider-exact",
    });
  });

  it("demotes promptless provider usage and replaces it with a newer estimate", () => {
    const current = recordContextUsageSnapshot(
      target,
      undefined,
      usage,
      undefined,
      () => 1,
    );
    const promptless: TokenUsage = {
      promptTokens: 0,
      promptTokensKnown: false,
      completionTokens: 50,
      totalTokens: 50,
      exact: true,
      reasoningTokens: 12,
    };
    const stale = recordContextUsageSnapshot(
      target,
      current,
      promptless,
      undefined,
      () => 2,
    );
    const estimated = estimatedContextSnapshot(target, stale, 720, () => 3)!;

    expect(stale).toMatchObject({
      contextTokens: 600,
      scope: "unknown",
      precision: "unknown",
      cache: { kind: "unknown" },
      reasoning: { kind: "reported", outputTokens: 12 },
    });
    expect(estimated).toMatchObject({
      contextTokens: 720,
      scope: "assembled-request",
      precision: "estimate",
      cache: { kind: "unknown" },
      reasoning: { kind: "unknown" },
      observedAt: 3,
    });
  });
});
