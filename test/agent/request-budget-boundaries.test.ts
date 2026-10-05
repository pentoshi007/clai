import { describe, expect, it, vi } from "vitest";
import { resolveRequestBudget } from "../../src/agent/request-budget.js";
import { planCompactionAdmission } from "../../src/agent/turn/compaction-admission.js";
import { RequestOverLimitError } from "../../src/agent/request-accounting.js";
import { assembleRequest } from "../../src/agent/turn/loop/request-assembly.js";

describe("default and custom compaction targets", () => {
  it.each([
    { contextLimitTokens: undefined, trigger: 280_000 },
    { contextLimitTokens: 253_000, trigger: 202_400 },
    { contextLimitTokens: 1_000_000, trigger: 800_000 },
  ].flatMap((window) => [-1, 0, 1].map((offset) => ({
    ...window,
    tokens: window.trigger + offset,
  }))))("admits compaction at the boundary: %j", async ({ tokens, trigger, contextLimitTokens }) => {
    const buildDurableEnvelope = vi.fn(async () => "durable state");
    const result = await planCompactionAdmission({
      messages: [
        { role: "system", content: "instructions" },
        { role: "user", content: "original task" },
        { role: "assistant", content: "completed work" },
        { role: "user", content: "revision" },
      ],
      provider: "openai",
      model: "gpt-5",
      dialect: "openai",
      keepRecent: 2,
      contextLimitTokens,
      estimateRequestTokens: () => tokens,
      selectTools: () => undefined,
      buildDurableEnvelope,
      isSuppressed: () => false,
    });
    expect(result.admitted).toBe(tokens >= trigger);
    expect(buildDurableEnvelope).toHaveBeenCalledTimes(tokens >= trigger ? 1 : 0);
  });

  it("uses the Kiro Opus window and custom thresholds exactly", () => {
    expect(
      resolveRequestBudget({ provider: "kiro", model: "claude-opus-5.5-thinking" }),
    ).toMatchObject({ windowTokens: 1_000_000, configured: 700_000, effectiveTrigger: 700_000 });
    expect(
      resolveRequestBudget({
        provider: "kiro",
        model: "claude-opus-5.5-thinking",
        contextLimitTokens: 400_000,
      }),
    ).toMatchObject({
      configured: 320_000,
      effectiveTrigger: 320_000,
      windowSource: "session-override",
    });
  });

  it("compacts a 200k model at 70%, inside the safety reserve", () => {
    expect(resolveRequestBudget({ provider: "anthropic", model: "claude-sonnet-4" }))
      .toMatchObject({ configured: 140_000, effectiveTrigger: 140_000, clampedByModel: false });
  });

  it("falls back to the 200k default window when nothing better is known", () => {
    expect(resolveRequestBudget({ provider: "tokenrouter", model: "unlisted-model-xyz" }))
      .toMatchObject({ windowTokens: 200_000, windowSource: "default", effectiveTrigger: 140_000 });
  });

  it("clamps small windows below 80% so output and compaction headroom still fit", () => {
    expect(resolveRequestBudget({ contextLimitTokens: 32_768 }))
      .toMatchObject({ configured: 26_214, effectiveTrigger: 16_896, clampedByModel: true });
  });

  it.each([NaN, Infinity, -Infinity])("ignores invalid custom limits: %s", (contextLimitTokens) => {
    expect(resolveRequestBudget({ contextLimitTokens }).effectiveTrigger)
      .toBe(140_000);
  });
});

describe("dispatch output headroom", () => {
  it.each([
    { model: "gpt-4", contextLimitTokens: undefined, expectedOutput: 2_048 },
    { model: "gpt-5", contextLimitTokens: 20_000, expectedOutput: 5_000 },
  ])("dispatches a small request within a small window: %j", async ({ model, contextLimitTokens, expectedOutput }) => {
    const assembled = await assembleRequest({
      messages: [{ role: "user", content: "hello" }],
      provider: "openai",
      model,
      dialect: "openai",
      nativeToolsActive: true,
      thinking: undefined,
      step: 1,
      contextLimitTokens,
      estimateRequestTokens: () => 6,
      selectTools: () => undefined,
      notify: vi.fn(),
      audit: vi.fn(async () => {}),
    }, {
      freeTierConsecutiveFailures: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      retryWithoutThinking: false,
    });
    expect(assembled.stepMaxTokens).toBe(expectedOutput);
  });

  it("reserves an expanded continuation budget instead of the default 24k", async () => {
    const messages = [{ role: "user" as const, content: "x".repeat(460_000) }];
    const ports = {
      messages,
      provider: "openai" as const,
      model: "gpt-5",
      dialect: "openai" as const,
      nativeToolsActive: true,
      thinking: undefined,
      step: 1,
      contextLimitTokens: 200_000,
      estimateRequestTokens: () => 140_000,
      selectTools: () => undefined,
      notify: vi.fn(),
      audit: vi.fn(async () => {}),
    };
    const state = {
      freeTierConsecutiveFailures: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      retryWithoutThinking: false,
    };
    await expect(assembleRequest(ports, state)).resolves.toMatchObject({ stepMaxTokens: 24_576 });
    await expect(assembleRequest(ports, { ...state, continuationBudgetFloor: 65_536 }))
      .rejects.toBeInstanceOf(RequestOverLimitError);
    expect(ports.audit).toHaveBeenCalledWith("agent.request.over-limit-blocked", expect.objectContaining({
      reservedOutputTokens: 65_536,
      effectiveSafeTokens: 132_416,
    }));
    expect(messages[0]!.content).toHaveLength(460_000);
  });

  it("dispatches on the provider-grounded measurement when the raw estimate overshoots", async () => {
    const assembled = await assembleRequest({
      messages: [{ role: "user", content: "x".repeat(460_000) }],
      provider: "openai",
      model: "gpt-5",
      dialect: "openai",
      nativeToolsActive: true,
      thinking: undefined,
      step: 1,
      contextLimitTokens: 200_000,
      measureRequestTokens: () => 64_000,
      estimateRequestTokens: () => 254_000,
      selectTools: () => undefined,
      notify: vi.fn(),
      audit: vi.fn(async () => {}),
    }, {
      freeTierConsecutiveFailures: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      retryWithoutThinking: false,
    });

    expect(assembled.stepMaxTokens).toBe(24_576);
  });

  it("blocks dispatch when the provider-grounded measurement exceeds the safe window", async () => {
    const audit = vi.fn(async () => {});
    await expect(assembleRequest({
      messages: [{ role: "user", content: "hello" }],
      provider: "openai",
      model: "gpt-5",
      dialect: "openai",
      nativeToolsActive: true,
      thinking: undefined,
      step: 1,
      contextLimitTokens: 200_000,
      measureRequestTokens: () => 190_000,
      estimateRequestTokens: () => 10,
      selectTools: () => undefined,
      notify: vi.fn(),
      audit,
    }, {
      freeTierConsecutiveFailures: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      retryWithoutThinking: false,
    })).rejects.toBeInstanceOf(RequestOverLimitError);
    expect(audit).toHaveBeenCalledWith("agent.request.over-limit-blocked", expect.objectContaining({
      requestTokens: 190_000,
      tokenMeasurement: "provider-reported",
      effectiveSafeTokens: 173_376,
    }));
  });
});
