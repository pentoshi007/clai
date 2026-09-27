import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { CompactionOverLimitError } from "../../src/agent/compaction-executor.js";
import { CompactionAttemptLedger } from "../../src/agent/compaction-attempt.js";
import {
  createCompactionCoordinator,
  type CompactionCoordinatorPorts,
} from "../../src/agent/turn/compaction-coordinator.js";
import {
  projectMeasuredTokens,
  providerContextMeasurement,
} from "../../src/agent/turn/provider-measurement.js";

const messages = (): ChatMessage[] => [
  { role: "user", content: "u1" },
  { role: "assistant", content: "a1" },
  { role: "user", content: "u2" },
  { role: "assistant", content: "a2" },
  { role: "user", content: "u3" },
];

const ports = (
  overrides: Partial<CompactionCoordinatorPorts> = {},
): CompactionCoordinatorPorts => ({
  messages: messages(),
  provider: () => "nvidia",
  model: () => "test-model",
  dialect: () => "native",
  keepRecent: 2,
  contextLimitTokens: () => 200_000,
  estimateRequestTokens: () => 190_000,
  selectTools: () => undefined,
  buildDurableEnvelope: async () => undefined,
  attempts: new CompactionAttemptLedger(),
  executionState: {},
  newCompactionId: () => "compact-test",
  lastSuccessfulRequestSnapshot: () => undefined,
  clearSuccessfulRequestSnapshot: () => undefined,
  clearProviderMeasurement: () => undefined,
  summarize: async () => "summary",
  loadPlan: async () => undefined,
  instructionsBlock: () => undefined,
  skillsBlock: () => undefined,
  planApproved: () => false,
  resetReadOnlyGuard: () => undefined,
  refreshSessionState: () => undefined,
  setLastCompactionMsgCount: () => undefined,
  writeStarted: () => undefined,
  writeFailed: () => undefined,
  writeCompleted: () => undefined,
  notify: () => undefined,
  audit: () => undefined,
  ...overrides,
});

describe("compaction coordinator spam guards", () => {
  it("runs a forced compaction with no snapshot by falling back to a fresh summary request", async () => {
    const writeStarted = vi.fn();
    const writeFailed = vi.fn();
    const coordinator = createCompactionCoordinator(
      ports({ writeStarted, writeFailed }),
    );

    await coordinator("stream-recovery:context-overflow", {
      bypassThreshold: true,
      retrySuppressed: true,
    });

    expect(writeStarted).toHaveBeenCalledTimes(1);
    expect(writeFailed).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("no successful live model request"),
      expect.any(Number),
    );
  });

  it("still runs an unforced compaction when a snapshot exists", async () => {
    const writeStarted = vi.fn();
    const coordinator = createCompactionCoordinator(
      ports({
        writeStarted,
        estimateRequestTokens: () => 1_000_000,
        lastSuccessfulRequestSnapshot: () => ({
          provider: "nvidia",
          model: "test-model",
          messages: messages(),
        }),
      }),
    );

    await coordinator("auto-token-budget");

    expect(writeStarted).toHaveBeenCalledTimes(1);
  });
});


it("falls back from an over-limit replay to one bounded prefix slice", async () => {
  const oversized = messages().map((message) => ({
    ...message,
    content: `${message.content} ${"x".repeat(50_000)}`,
  }));
  const summarize = vi
    .fn()
    .mockRejectedValueOnce(
      new CompactionOverLimitError("replay overflow", 190_000, 180_000),
    )
    .mockResolvedValueOnce(
      "## Current state\nThe oversized replay was replaced by a bounded prefix summary with the recent turns retained.\n## Remaining work\nContinue the active task from the preserved tail.",
    );
  const writeCompleted = vi.fn();
  const writeFailed = vi.fn();
  const audit = vi.fn();
  const coordinator = createCompactionCoordinator(
    ports({
      messages: oversized,
      contextLimitTokens: () => 1_000_000,
      estimateRequestTokens: (candidate) =>
        candidate.some((message) =>
          message.content.startsWith("Session memory from compacted earlier turns:"),
        )
          ? 10_000
          : 190_000,
      summarize,
      lastSuccessfulRequestSnapshot: () => ({
        provider: "nvidia",
        model: "test-model",
        messages: oversized,
      }),
      writeCompleted,
      writeFailed,
      audit,
    }),
  );

  await coordinator("auto-token-budget", { bypassThreshold: true });

  expect(summarize).toHaveBeenCalledTimes(2);
  expect(audit).toHaveBeenCalledWith(
    "agent.compact.slice-fallback",
    expect.objectContaining({ requestTokens: 190_000, safeLimit: 180_000 }),
  );
  expect(writeCompleted).toHaveBeenCalledTimes(1);
  expect(writeFailed).not.toHaveBeenCalled();
});

it("retains the exact transcript when durable-state refresh fails", async () => {
  const original: ChatMessage[] = [
    { role: "user", content: "before" },
    { role: "tool", toolCallId: "orphan", content: "unmatched" },
    { role: "user", content: "continue" },
  ];
  const snapshot = structuredClone(original);
  const clearSuccessfulRequestSnapshot = vi.fn();
  const writeStarted = vi.fn();
  const coordinator = createCompactionCoordinator(
    ports({
      messages: original,
      buildDurableEnvelope: async () => {
        throw new Error("plan store unavailable");
      },
      clearSuccessfulRequestSnapshot,
      writeStarted,
    }),
  );

  await expect(
    coordinator("auto-token-budget", { bypassThreshold: true }),
  ).rejects.toThrow("plan store unavailable");
  expect(original).toEqual(snapshot);
  expect(clearSuccessfulRequestSnapshot).not.toHaveBeenCalled();
  expect(writeStarted).not.toHaveBeenCalled();
});


it("re-arms once after success and admits a later estimate crossing", async () => {
  const stablePrefix = "stable cache prefix";
  const liveMessages: ChatMessage[] = [
    { role: "system", content: stablePrefix },
    ...messages().map((message) => ({
      ...message,
      content: `${message.content} ${"x".repeat(50_000)}`,
    })),
  ];
  let crossed = true;
  let providerMeasurement = providerContextMeasurement(100_000, 100_000);
  const writeStarted = vi.fn();
  const writeCompleted = vi.fn(() => {
    crossed = false;
  });
  const clearProviderMeasurement = vi.fn(() => {
    providerMeasurement = undefined;
  });
  const summarize = vi.fn(async () =>
    [
      "## Current state",
      "The active work and exact durable state were preserved.",
      "## Remaining work",
      "Continue the next task from the retained recent turn.",
    ].join("\n"),
  );
  const coordinator = createCompactionCoordinator(
    ports({
      messages: liveMessages,
      estimateRequestTokens: (candidate) =>
        candidate === liveMessages && crossed ? 210_000 : 50_000,
      measureRequestTokens: (estimate) =>
        providerMeasurement ? projectMeasuredTokens(providerMeasurement, estimate) : undefined,
      clearProviderMeasurement,
      summarize,
      writeStarted,
      writeCompleted,
    }),
  );

  await coordinator("auto-token-budget");
  await coordinator("auto-token-budget");
  expect(writeStarted).toHaveBeenCalledTimes(1);
  expect(clearProviderMeasurement).toHaveBeenCalledTimes(1);
  expect(liveMessages[0]?.content).toBe(stablePrefix);

  liveMessages.push({ role: "user", content: "new threshold crossing" });
  crossed = true;
  await coordinator("auto-token-budget");

  expect(writeStarted).toHaveBeenCalledTimes(2);
  expect(writeCompleted).toHaveBeenCalledTimes(2);
  expect(summarize).toHaveBeenCalledTimes(2);
  expect(clearProviderMeasurement).toHaveBeenCalledTimes(2);
  expect(liveMessages[0]?.content).toBe(stablePrefix);
  expect(
    liveMessages.some((message) => message.content === "new threshold crossing"),
  ).toBe(true);
});


it("projects the post-compaction size from the provider measurement before releasing it", async () => {
  const liveMessages: ChatMessage[] = [
    { role: "system", content: "stable cache prefix" },
    ...messages().map((message) => ({
      ...message,
      content: `${message.content} ${"x".repeat(50_000)}`,
    })),
  ];
  let summarized = false;
  let providerMeasurement = providerContextMeasurement(400_000, 200_000);
  const writeCompleted = vi.fn();
  const notify = vi.fn();
  const coordinator = createCompactionCoordinator(
    ports({
      messages: liveMessages,
      estimateRequestTokens: () => (summarized ? 5_000 : 200_000),
      measureRequestTokens: (estimate) =>
        providerMeasurement ? projectMeasuredTokens(providerMeasurement, estimate) : undefined,
      clearProviderMeasurement: () => {
        providerMeasurement = undefined;
      },
      summarize: async () => {
        summarized = true;
        return [
          "## Current state",
          "The active work and exact durable state were preserved.",
          "## Remaining work",
          "Continue the next task from the retained recent turn.",
        ].join("\n");
      },
      writeCompleted,
      notify,
    }),
  );

  await coordinator("auto-token-budget");

  expect(writeCompleted).toHaveBeenCalledWith(
    "compact-test",
    expect.any(String),
    400_000,
    10_000,
    "provider-reported",
  );
  expect(providerMeasurement).toBeUndefined();
  expect(notify).toHaveBeenCalledWith(
    "info",
    expect.stringContaining("400,000 tokens → ~10,000 tokens"),
  );
});
