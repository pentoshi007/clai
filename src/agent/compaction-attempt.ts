import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";

export const COMPACTION_RETRY_COOLDOWN_MS = 60_000;

export const COMPACTION_MAX_ATTEMPTS = 3;

export interface CompactionAttemptKeyInput {
  readonly messages: readonly ChatMessage[];
  readonly provider: string;
  readonly model: string;
  readonly dialect: string;
  readonly triggerTokens: number;
  readonly schemaHash: string;
  readonly durableEnvelope?: string | undefined;
}

function stableValue(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableValue).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(",")}}`;
}

export function compactionAttemptKey(input: CompactionAttemptKeyInput): string {
  const transcript = createHash("sha256");
  transcript.update(stableValue(input.messages));
  return createHash("sha256")
    .update(
      [
        transcript.digest("hex"),
        input.provider,
        input.model,
        input.dialect,
        String(input.triggerTokens),
        input.schemaHash,
        input.durableEnvelope ?? "",
      ].join("|"),
    )
    .digest("hex")
    .slice(0, 32);
}

export class CompactionAttemptLedger {
  private readonly failures = new Map<
    string,
    { readonly failedAt: number; readonly count: number; readonly exhausted: boolean }
  >();

  constructor(
    private readonly cooldownMs: number = COMPACTION_RETRY_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
    private readonly maxAttempts: number = COMPACTION_MAX_ATTEMPTS,
  ) {}

  isSuppressed(key: string): boolean {
    const record = this.failures.get(key);
    if (record === undefined) return false;
    if (record.exhausted) return true;
    if (this.now() - record.failedAt < this.cooldownMs) return true;
    this.failures.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    const prior = this.failures.get(key);
    const count = (prior?.count ?? 0) + 1;
    this.failures.set(key, {
      failedAt: this.now(),
      count,
      exhausted: count >= this.maxAttempts,
    });
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  attemptCount(key: string): number {
    return this.failures.get(key)?.count ?? 0;
  }

  isExhausted(key: string): boolean {
    return this.failures.get(key)?.exhausted === true;
  }

  clear(): void {
    this.failures.clear();
  }
}
