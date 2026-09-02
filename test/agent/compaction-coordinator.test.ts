import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { CompactionAttemptLedger } from "../../src/agent/compaction-attempt.js";
import {
  createCompactionCoordinator,
  type CompactionCoordinatorPorts,
} from "../../src/agent/turn/compaction-coordinator.js";

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

    await coordinator("stream-recovery:context-overflow", true);

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

    await coordinator("auto-token-budget", false);

    expect(writeStarted).toHaveBeenCalledTimes(1);
  });
});
