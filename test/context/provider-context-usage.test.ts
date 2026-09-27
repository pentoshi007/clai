import { afterEach, describe, expect, it } from "vitest";

import { resolveRequestBudget } from "../../src/agent/request-budget.js";
import {
  contextSnapshotForRoute,
  recordContextUsageSnapshot,
} from "../../src/app/controllers/session-context-usage.js";
import {
  clearModelCatalogFacts,
  registerModelCatalogFacts,
} from "../../src/llm/capabilities.js";
import {
  resolveContextWindow,
} from "../../src/llm/context-windows.js";
import {
  toLegacyContextUsage,
} from "../../src/llm/context-snapshot.js";
import {
  providerRatioPromptTokens,
  providerRatioUsage,
} from "../../src/llm/provider-context-usage.js";
import { formatContextChip } from "../../src/llm/token-usage.js";

const model = "provider-context-test-model";

function registerWindow(tokens = 1_000_000): void {
  registerModelCatalogFacts("kiro", { id: model, contextTokens: tokens });
}

afterEach(() => {
  clearModelCatalogFacts();
});

describe("provider context windows", () => {
  it("prefers custom then provider, and clamps custom to provider", () => {
    registerWindow();
    expect(resolveContextWindow({ provider: "kiro", model })).toEqual({
      tokens: 1_000_000,
      source: "provider",
      providerTokens: 1_000_000,
      clampedToProvider: false,
    });
    expect(
      resolveContextWindow({
        provider: "kiro",
        model,
        contextLimitTokens: 800_000,
      }),
    ).toMatchObject({
      tokens: 800_000,
      source: "session-override",
      providerTokens: 1_000_000,
      overrideTokens: 800_000,
      clampedToProvider: false,
    });
    expect(
      resolveContextWindow({
        provider: "kiro",
        model,
        contextLimitTokens: 2_000_000,
      }),
    ).toMatchObject({
      tokens: 1_000_000,
      source: "session-override",
      providerTokens: 1_000_000,
      overrideTokens: 2_000_000,
      clampedToProvider: true,
    });
  });

  it("ignores undersized overrides and distinguishes table and default windows", () => {
    registerWindow();
    expect(
      resolveContextWindow({
        provider: "kiro",
        model,
        contextLimitTokens: 19_999,
      }).source,
    ).toBe("provider");
    expect(
      resolveContextWindow({ provider: "anthropic", model: "claude-sonnet-4" }),
    ).toMatchObject({ source: "model-table", tokens: 200_000 });
    expect(
      resolveContextWindow({ provider: "openai", model: "unknown-model" }),
    ).toMatchObject({ source: "default", tokens: 200_000 });
  });
});

describe("provider ratio usage", () => {
  it("normalizes valid percentages and rejects unusable measurements", () => {
    expect(providerRatioPromptTokens(12.5, 256_000)).toBe(32_000);
    expect(providerRatioPromptTokens(0.00001, 256_000)).toBe(1);
    expect(providerRatioPromptTokens(101, 256_000)).toBe(256_000);
    for (const percentage of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      expect(providerRatioPromptTokens(percentage, 256_000)).toBeUndefined();
    }
    expect(providerRatioPromptTokens(10, undefined)).toBeUndefined();
    expect(providerRatioPromptTokens(10, Number.NaN)).toBeUndefined();
  });

  it("tags provider measurements with the window used for conversion", () => {
    expect(
      providerRatioUsage({ percentUsed: 12.5, windowTokens: 1_000_000 }),
    ).toMatchObject({
      promptTokens: 125_000,
      totalTokens: 125_000,
      exact: false,
      promptTokensSource: "provider-ratio",
      contextWindowTokens: 1_000_000,
    });
  });
});

describe("provider-window compaction and display", () => {
  it("compacts at 70% of the provider-advertised window", () => {
    registerWindow();
    expect(resolveRequestBudget({ provider: "kiro", model })).toMatchObject({
      windowTokens: 1_000_000,
      windowSource: "provider",
      configured: 700_000,
      effectiveTrigger: 700_000,
    });
  });

  it("uses 70% of a custom window after provider clamping", () => {
    registerWindow();
    expect(
      resolveRequestBudget({
        provider: "kiro",
        model,
        contextLimitTokens: 500_000,
      }),
    ).toMatchObject({ configured: 350_000, effectiveTrigger: 350_000 });
    expect(
      resolveRequestBudget({
        provider: "kiro",
        model,
        contextLimitTokens: 2_000_000,
      }),
    ).toMatchObject({ configured: 700_000, effectiveTrigger: 700_000 });
  });

  it("keeps provider-derived tokens while custom limits change the denominator", () => {
    registerWindow();
    const usage = providerRatioUsage({
      percentUsed: 12.5,
      windowTokens: 1_000_000,
    })!;
    const attempt = {
      kind: "generation" as const,
      sequence: 1,
      provider: "kiro" as const,
      model,
      mode: "stream" as const,
      reason: "initial" as const,
      outcome: "success" as const,
    };
    const providerSnapshot = recordContextUsageSnapshot(
      { provider: "kiro", model },
      undefined,
      usage,
      attempt,
      () => 1,
    );
    expect(providerSnapshot).toMatchObject({
      contextTokens: 125_000,
      precision: "provider-ratio",
      limit: {
        source: "model-catalog",
        tokens: 1_000_000,
        compactTriggerTokens: 700_000,
      },
    });
    expect(
      formatContextChip(toLegacyContextUsage(providerSnapshot), { compact: true }),
    ).toBe("ctx:~125k/1M 13%");

    const customSnapshot = recordContextUsageSnapshot(
      { provider: "kiro", model, contextLimitTokens: 500_000 },
      undefined,
      usage,
      attempt,
      () => 2,
    );
    expect(customSnapshot).toMatchObject({
      contextTokens: 125_000,
      limit: { tokens: 500_000, compactTriggerTokens: 350_000 },
    });
    expect(
      formatContextChip(toLegacyContextUsage(customSnapshot), { compact: true }),
    ).toBe("ctx:~125k/500k 25%");
    expect(
      contextSnapshotForRoute(
        { provider: "kiro", model: "other-model" },
        providerSnapshot,
      ),
    ).toMatchObject({ contextTokens: 125_000, precision: "estimate" });
  });
});
