import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADAPTIVE_MAX_TOKENS_LIGHT,
  ADAPTIVE_MAX_TOKENS_TOOL_STEP,
  DEFAULT_FS_PASSTHROUGH_CAP_CHARS,
  DEFAULT_SOFT_COMPACT_TOKEN_BUDGET,
  HARD_COMPACT_TOKEN_BUDGET,
  LEGACY_MAX_TOKENS,
  autoCompactTriggerTokens,
  dedupeToolContextOutput,
  freeTierGuardNotices,
  getReliabilityPolicy,
  hashToolResultContent,
  resolveStepMaxTokens,
} from "../src/agent/reliability-policy.js";

afterEach(() => {
  delete process.env.CLAI_SOFT_EARLY_COMPACT;
  delete process.env.CLAI_SOFT_COMPACT_TOKENS;
  delete process.env.CLAI_FS_PASSTHROUGH_CHARS;
  delete process.env.CLAI_ADAPTIVE_MAX_TOKENS;
  delete process.env.CLAI_FREE_TIER_GUARD;
  delete process.env.CLAI_TOOL_RESULT_DEDUP;
  delete process.env.CLAI_SLIM_NATIVE_PROMPT;
});

describe("reliability policy (E1–E6)", () => {
  it("E1: soft early compact defaults to 180k for every provider/model", () => {
    const p = getReliabilityPolicy();
    expect(p.softEarlyCompact).toBe(true);
    expect(p.softCompactTokenBudget).toBe(DEFAULT_SOFT_COMPACT_TOKEN_BUDGET);
    expect(DEFAULT_SOFT_COMPACT_TOKEN_BUDGET).toBe(180_000);
    expect(autoCompactTriggerTokens(p)).toBe(180_000);
    expect(autoCompactTriggerTokens(p)).toBe(HARD_COMPACT_TOKEN_BUDGET);
    expect(
      autoCompactTriggerTokens(p, {
        provider: "nvidia",
        model: "openai/gpt-oss-20b",
      }),
    ).toBe(180_000);
    expect(
      autoCompactTriggerTokens(p, {
        provider: "modal",
        model: "moonshotai/Kimi-K3",
      }),
    ).toBe(180_000);
  });

  it("E1: a session model window compacts at exactly 70%", () => {
    const p = getReliabilityPolicy();
    expect(
      autoCompactTriggerTokens(p, {
        provider: "tokenrouter",
        model: "custom-1m",
        contextLimitTokens: 1_000_000,
      }),
    ).toBe(700_000);
    expect(
      autoCompactTriggerTokens(p, {
        provider: "tokenrouter",
        model: "custom-253k",
        contextLimitTokens: 253_000,
      }),
    ).toBe(177_100);
  });

  it("E1: soft compact trigger can be lowered via env", () => {
    process.env.CLAI_SOFT_COMPACT_TOKENS = "60000";
    const p = getReliabilityPolicy();
    expect(autoCompactTriggerTokens(p)).toBe(60_000);
    expect(autoCompactTriggerTokens(p)).toBeLessThan(HARD_COMPACT_TOKEN_BUDGET);
  });

  it("E1: soft early compact can be disabled → hard budget only", () => {
    process.env.CLAI_SOFT_EARLY_COMPACT = "0";
    const p = getReliabilityPolicy();
    expect(p.softEarlyCompact).toBe(false);
    expect(autoCompactTriggerTokens(p)).toBeLessThanOrEqual(HARD_COMPACT_TOKEN_BUDGET);
  });

  it("E2: fs passthrough default is tiered 64k not 400k", () => {
    expect(getReliabilityPolicy().fsPassthroughCapChars).toBe(
      DEFAULT_FS_PASSTHROUGH_CAP_CHARS,
    );
    process.env.CLAI_FS_PASSTHROUGH_CHARS = "12000";
    expect(getReliabilityPolicy().fsPassthroughCapChars).toBe(12_000);
  });

  it("E3: adaptive maxTokens keeps write headroom; can restore legacy 32k", () => {
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: true,
        toolsAttached: true,
      }),
    ).toBe(ADAPTIVE_MAX_TOKENS_TOOL_STEP);
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: false,
        toolsAttached: false,
      }),
    ).toBe(ADAPTIVE_MAX_TOKENS_LIGHT);

    process.env.CLAI_ADAPTIVE_MAX_TOKENS = "0";
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: true,
        toolsAttached: true,
        policy: getReliabilityPolicy(),
      }),
    ).toBe(LEGACY_MAX_TOKENS);
  });

  it("E3: thinking-enabled steps keep the legacy 32k budget so reasoning cannot starve the answer", () => {
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: true,
        toolsAttached: true,
        thinkingEnabled: true,
      }),
    ).toBe(LEGACY_MAX_TOKENS);
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: false,
        toolsAttached: false,
        thinkingEnabled: true,
      }),
    ).toBe(LEGACY_MAX_TOKENS);
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: true,
        toolsAttached: true,
        thinkingEnabled: true,
        recoveryNudge: true,
      }),
    ).toBeLessThan(LEGACY_MAX_TOKENS);
    expect(
      resolveStepMaxTokens({
        nativeToolsActive: true,
        toolsAttached: true,
        thinkingEnabled: true,
        truncationDepth: 1,
      }),
    ).toBe(65_536);
  });

  it("E4: free-tier notices are advisory only and never empty for large context", () => {
    const large = freeTierGuardNotices({
      provider: "bynara",
      estimatedInputTokens: 50_000,
      consecutiveFailures: 0,
    });
    expect(large.some((n) => /Large context/i.test(n))).toBe(true);

    const fails = freeTierGuardNotices({
      provider: "bynara",
      estimatedInputTokens: 1_000,
      consecutiveFailures: 2,
    });
    expect(fails.some((n) => /failed/i.test(n))).toBe(true);

    // Paid providers: no free-tier spam.
    expect(
      freeTierGuardNotices({
        provider: "openai",
        estimatedInputTokens: 90_000,
        consecutiveFailures: 5,
      }),
    ).toEqual([]);

    process.env.CLAI_FREE_TIER_GUARD = "0";
    expect(
      freeTierGuardNotices({
        provider: "bynara",
        estimatedInputTokens: 90_000,
        consecutiveFailures: 5,
        policy: getReliabilityPolicy(),
      }),
    ).toEqual([]);
  });

  it("E5: dedupes identical large tool bodies to a pointer", () => {
    const body = "x".repeat(500) + "\nunique-tail";
    const seen = new Map<string, { toolName: string; count: number }>();
    const first = dedupeToolContextOutput({
      content: body,
      toolName: "fs.read",
      seenHashes: seen,
    });
    expect(first.deduped).toBe(false);
    expect(first.content).toBe(body);

    const second = dedupeToolContextOutput({
      content: body,
      toolName: "fs.read",
      artifactPath: "/tmp/art.txt",
      seenHashes: seen,
    });
    expect(second.deduped).toBe(true);
    expect(second.content).toMatch(/duplicate tool output/i);
    expect(second.content).toContain("/tmp/art.txt");
    expect(second.content).not.toContain("unique-tail");
    expect(second.hash).toBe(hashToolResultContent(body));
  });

  it("E5: serves full content again when an already-collapsed body repeats", () => {
    const body = "z".repeat(600) + "\nrecoverable-tail";
    const seen = new Map<string, { toolName: string; count: number }>();
    const first = dedupeToolContextOutput({ content: body, toolName: "fs.read", seenHashes: seen });
    const second = dedupeToolContextOutput({ content: body, toolName: "fs.read", seenHashes: seen });
    const third = dedupeToolContextOutput({ content: body, toolName: "fs.read", seenHashes: seen });
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(third.deduped).toBe(false);
    expect(third.content).toBe(body);
    expect(third.content).toContain("recoverable-tail");
  });

  it("E5: does not pointer-collapse tiny results", () => {
    const seen = new Map<string, { toolName: string; count: number }>();
    const tiny = "ok";
    const a = dedupeToolContextOutput({
      content: tiny,
      toolName: "sysinfo",
      seenHashes: seen,
    });
    const b = dedupeToolContextOutput({
      content: tiny,
      toolName: "sysinfo",
      seenHashes: seen,
    });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(b.content).toBe(tiny);
  });

  it("E5 can be disabled", () => {
    process.env.CLAI_TOOL_RESULT_DEDUP = "0";
    const body = "y".repeat(800);
    const seen = new Map<string, { toolName: string; count: number }>();
    const policy = getReliabilityPolicy();
    dedupeToolContextOutput({
      content: body,
      toolName: "fs.read",
      seenHashes: seen,
      policy,
    });
    const second = dedupeToolContextOutput({
      content: body,
      toolName: "fs.read",
      seenHashes: seen,
      policy,
    });
    expect(second.deduped).toBe(false);
    expect(second.content).toBe(body);
  });
});
