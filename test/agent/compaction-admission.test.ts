import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { compactionAttemptKey } from "../../src/agent/compaction-attempt.js";
import { toolSchemaHash } from "../../src/agent/context-breakdown.js";
import { autoCompactTriggerTokens } from "../../src/agent/request-budget.js";
import {
  planCompactionAdmission,
  type CompactionAdmissionPorts,
} from "../../src/agent/turn/compaction-admission.js";

const history = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${index}`,
  }));

const trigger = autoCompactTriggerTokens({
  provider: "nvidia",
  model: "test-model",
  contextLimitTokens: 200_000,
});

const ports = (
  overrides: Partial<CompactionAdmissionPorts> = {},
): CompactionAdmissionPorts => ({
  messages: history(8),
  provider: "nvidia",
  model: "test-model",
  dialect: "native",
  keepRecent: 2,
  contextLimitTokens: 200_000,
  estimateRequestTokens: () => trigger,
  selectTools: () => undefined,
  buildDurableEnvelope: async () => "durable state",
  isSuppressed: () => false,
  ...overrides,
});

describe("compaction admission", () => {
  it("admits at the trigger and reports the canonical attempt key", async () => {
    const admission = await planCompactionAdmission(ports());

    expect(admission).toEqual({
      admitted: true,
      beforeTokens: trigger,
      measurement: "estimated",
      compactTrigger: trigger,
      durableEnvelope: "durable state",
      attemptKey: compactionAttemptKey({
        messages: history(8),
        provider: "nvidia",
        model: "test-model",
        dialect: "native",
        triggerTokens: trigger,
        schemaHash: toolSchemaHash(undefined),
        durableEnvelope: "durable state",
      }),
    });
  });

  it("rejects below the trigger before building the envelope", async () => {
    const buildDurableEnvelope = vi.fn(async () => "durable state");
    await expect(
      planCompactionAdmission(
        ports({
          estimateRequestTokens: () => trigger - 1,
          buildDurableEnvelope,
        }),
      ),
    ).resolves.toEqual({ admitted: false });
    expect(buildDurableEnvelope).not.toHaveBeenCalled();
  });

  it("admits a structurally short history when compaction can still remove an older turn", async () => {
    const buildDurableEnvelope = vi.fn(async () => "durable state");
    const admission = await planCompactionAdmission(
      ports({ messages: history(4), buildDurableEnvelope }),
      { bypassThreshold: true },
    );
    expect(admission.admitted).toBe(true);
    expect(buildDurableEnvelope).toHaveBeenCalledTimes(1);
  });

  it("rejects a history with no safely removable turn", async () => {
    const buildDurableEnvelope = vi.fn(async () => "durable state");
    await expect(
      planCompactionAdmission(
        ports({ messages: history(2), buildDurableEnvelope }),
        { bypassThreshold: true },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(buildDurableEnvelope).not.toHaveBeenCalled();
  });

  it("bypasses the threshold without retrying a suppressed attempt", async () => {
    const isSuppressed = vi.fn(() => true);
    await expect(
      planCompactionAdmission(ports({ isSuppressed })),
    ).resolves.toEqual({ admitted: false });
    expect(isSuppressed).toHaveBeenCalledTimes(1);

    await expect(
      planCompactionAdmission(
        ports({ isSuppressed, estimateRequestTokens: () => 1 }),
        { bypassThreshold: true },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(isSuppressed).toHaveBeenCalledTimes(2);

    const retried = await planCompactionAdmission(
      ports({ isSuppressed, estimateRequestTokens: () => 1 }),
      { bypassThreshold: true, retrySuppressed: true },
    );
    expect(retried.admitted).toBe(true);
    expect(isSuppressed).toHaveBeenCalledTimes(2);
  });

  it("rejects a forced retry whose attempt key is exhausted, so stream recovery cannot loop on a dead context", async () => {
    const isExhausted = vi.fn(() => true);
    await expect(
      planCompactionAdmission(
        ports({ isExhausted, estimateRequestTokens: () => 1 }),
        { bypassThreshold: true, retrySuppressed: true },
      ),
    ).resolves.toEqual({ admitted: false });
    expect(isExhausted).toHaveBeenCalledTimes(1);
  });

  it("still retries forced compaction when the attempt key is not exhausted", async () => {
    const isExhausted = vi.fn(() => false);
    const forced = await planCompactionAdmission(
      ports({ isExhausted, estimateRequestTokens: () => 1 }),
      { bypassThreshold: true, retrySuppressed: true },
    );
    expect(forced.admitted).toBe(true);
    expect(isExhausted).toHaveBeenCalledTimes(1);
  });

  it("does not consult exhaustion when suppressed attempts cannot be retried", async () => {
    const isExhausted = vi.fn(() => false);
    await planCompactionAdmission(ports({ isExhausted }));
    expect(isExhausted).not.toHaveBeenCalled();
  });

  it("trusts the provider-grounded measurement over a higher local estimate", async () => {
    const audit = vi.fn();
    const buildDurableEnvelope = vi.fn(async () => "durable state");
    const measureRequestTokens = vi.fn(() => Math.floor(trigger / 4));
    await expect(
      planCompactionAdmission(
        ports({
          estimateRequestTokens: () => trigger,
          measureRequestTokens,
          buildDurableEnvelope,
          audit,
        }),
      ),
    ).resolves.toEqual({ admitted: false });
    expect(measureRequestTokens).toHaveBeenCalledWith(trigger);
    expect(buildDurableEnvelope).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      "agent.compact.skip-threshold",
      expect.objectContaining({ providerMeasuredTokens: Math.floor(trigger / 4) }),
    );
  });

  it("admits crossed provider truth when the estimate is lower", async () => {
    const admission = await planCompactionAdmission(
      ports({
        estimateRequestTokens: () => Math.floor(trigger * 0.8),
        measureRequestTokens: () => trigger,
      }),
    );
    expect(admission).toMatchObject({
      admitted: true,
      beforeTokens: trigger,
      measurement: "provider-reported",
    });
  });

  it("admits when provider-reported tokens reach the trigger", async () => {
    const admission = await planCompactionAdmission(
      ports({ measureRequestTokens: () => trigger }),
    );
    expect(admission).toMatchObject({
      admitted: true,
      beforeTokens: trigger,
      measurement: "provider-reported",
    });
  });

  it("never skips forced compaction on provider truth", async () => {
    const admission = await planCompactionAdmission(
      ports({
        estimateRequestTokens: () => 1,
        measureRequestTokens: () => 1,
      }),
      { bypassThreshold: true },
    );
    expect(admission.admitted).toBe(true);
  });

  it("audits admission diagnostics with estimate, calibration, and provider truth", async () => {
    const audit = vi.fn();
    await planCompactionAdmission(
      ports({ audit, measureRequestTokens: () => 150_000 }),
    );
    expect(audit).toHaveBeenCalledWith(
      "agent.compact.admission",
      expect.objectContaining({
        estimatedTokens: trigger,
        tokenMeasurement: "provider-reported",
        triggerTokens: trigger,
        providerMeasuredTokens: 150_000,
      }),
    );
  });
});
