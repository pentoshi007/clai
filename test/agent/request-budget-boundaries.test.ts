import { describe, expect, it, vi } from "vitest";
import { resolveRequestBudget } from "../../src/agent/request-budget.js";
import { planCompactionAdmission } from "../../src/agent/turn/compaction-admission.js";
import { RequestOverLimitError } from "../../src/agent/request-accounting.js";
import { assembleRequest } from "../../src/agent/turn/loop/request-assembly.js";

describe("default and custom compaction targets", () => {
  it.each([
    { contextLimitTokens: undefined, trigger: 200_000 },
    { contextLimitTokens: 253_000, trigger: 177_100 },
    { contextLimitTokens: 1_000_000, trigger: 700_000 },
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

  it("retains the safety reserve on a 200k model", () => {
    expect(resolveRequestBudget({ provider: "anthropic", model: "claude-sonnet-4" }))
      .toMatchObject({ configured: 200_000, effectiveTrigger: 156_992, clampedByModel: true });
  });

  it("gives the custom session window's 70% target precedence over the global budget", () => {
    expect(resolveRequestBudget({ overrideTokens: 60_000, contextLimitTokens: 253_000 }))
      .toMatchObject({ configured: 177_100, effectiveTrigger: 177_100, source: "session" });
  });

  it.each([NaN, Infinity, -Infinity])("keeps invalid budgets finite: %s", (overrideTokens) => {
    expect(resolveRequestBudget({ overrideTokens }).effectiveTrigger)
      .toBe(200_000);
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
      emitContextEstimate: vi.fn(),
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
      emitContextEstimate: vi.fn(),
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
});
