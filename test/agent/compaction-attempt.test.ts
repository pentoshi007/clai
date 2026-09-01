import { describe, expect, it } from "vitest";

import {
  COMPACTION_MAX_ATTEMPTS,
  CompactionAttemptLedger,
  compactionAttemptKey,
} from "../../src/agent/compaction-attempt.js";
import type { ChatMessage } from "../../src/types.js";

const messages: ChatMessage[] = [{ role: "user", content: "hello" }];

const keyFor = (content: string): string =>
  compactionAttemptKey({
    messages: [{ role: "user", content }],
    provider: "nvidia",
    model: "test-model",
    dialect: "native",
    triggerTokens: 100_000,
    schemaHash: "schema",
  });

describe("CompactionAttemptLedger", () => {
  it("suppresses a failed key during the cooldown and releases it afterward", () => {
    let now = 1_000;
    const ledger = new CompactionAttemptLedger(60_000, () => now);
    const key = keyFor("context-a");

    expect(ledger.isSuppressed(key)).toBe(false);
    ledger.recordFailure(key);
    expect(ledger.isSuppressed(key)).toBe(true);

    now += 61_000;
    expect(ledger.isSuppressed(key)).toBe(false);
  });

  it("permanently suppresses a key after the attempt budget is exhausted", () => {
    let now = 1_000;
    const ledger = new CompactionAttemptLedger(60_000, () => now);
    const key = keyFor("context-a");

    for (let attempt = 0; attempt < COMPACTION_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordFailure(key);
      now += 61_000;
    }

    expect(ledger.attemptCount(key)).toBe(COMPACTION_MAX_ATTEMPTS);
    expect(ledger.isExhausted(key)).toBe(true);
    expect(ledger.isSuppressed(key)).toBe(true);
  });

  it("does not exhaust before the attempt budget and resets on success", () => {
    let now = 1_000;
    const ledger = new CompactionAttemptLedger(60_000, () => now);
    const key = keyFor("context-a");

    ledger.recordFailure(key);
    ledger.recordFailure(key);
    expect(ledger.isExhausted(key)).toBe(false);

    ledger.recordSuccess(key);
    expect(ledger.attemptCount(key)).toBe(0);
    expect(ledger.isSuppressed(key)).toBe(false);
    expect(ledger.isExhausted(key)).toBe(false);
  });

  it("tracks exhaustion per attempt key so a different context can still compact", () => {
    const ledger = new CompactionAttemptLedger(60_000, () => 1_000);
    const stuck = keyFor("stuck-context");
    const fresh = keyFor("fresh-context");

    for (let attempt = 0; attempt < COMPACTION_MAX_ATTEMPTS; attempt += 1) {
      ledger.recordFailure(stuck);
    }

    expect(ledger.isSuppressed(stuck)).toBe(true);
    expect(ledger.isSuppressed(fresh)).toBe(false);
    expect(ledger.isExhausted(fresh)).toBe(false);
  });
});
