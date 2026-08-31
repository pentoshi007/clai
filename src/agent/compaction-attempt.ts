import { createHash } from "node:crypto";
import type { ChatMessage } from "../types.js";

export const COMPACTION_RETRY_COOLDOWN_MS = 60_000;

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
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly cooldownMs: number = COMPACTION_RETRY_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  isSuppressed(key: string): boolean {
    const failedAt = this.failures.get(key);
    if (failedAt === undefined) return false;
    if (this.now() - failedAt < this.cooldownMs) return true;
    this.failures.delete(key);
    return false;
  }

  recordFailure(key: string): void {
    this.failures.set(key, this.now());
  }

  recordSuccess(key: string): void {
    this.failures.delete(key);
  }

  clear(): void {
    this.failures.clear();
  }
}
