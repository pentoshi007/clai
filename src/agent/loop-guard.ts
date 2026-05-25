import type { ToolCall } from "../types.js";

export interface ToolAttempt {
  step: number;
  callName: string;
  canonicalSignature: string;
  ok: boolean;
  exitCode?: number | undefined;
}

/**
 * Track and detect tool-call repetition patterns so the agent doesn't
 * waste steps in loops.
 */
export class LoopGuard {
  private attempts: ToolAttempt[] = [];
  private signatureCount = new Map<string, number>();

  /**
   * Produce a canonical string for a (name, args) pair so that calls
   * with identical semantics match even if arg order differs or
   * command whitespace varies.
   */
  canonicalize(name: string, args: Record<string, unknown>): string {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(args).sort()) {
      let value = args[key];
      // Normalize command whitespace for shell.exec
      if (name === "shell.exec" && key === "command" && typeof value === "string") {
        value = value.trim().replace(/\s+/g, " ");
      }
      sorted[key] = value;
    }
    return `${name}::${JSON.stringify(sorted)}`;
  }

  recordAttempt(
    step: number,
    name: string,
    args: Record<string, unknown>,
    ok: boolean,
    exitCode?: number | undefined,
  ): void {
    const sig = this.canonicalize(name, args);
    this.attempts.push({ step, callName: name, canonicalSignature: sig, ok, exitCode });
    this.signatureCount.set(sig, (this.signatureCount.get(sig) ?? 0) + 1);
  }

  /**
   * Check whether the proposed call should be blocked as a repeat.
   *
   * Returns `{ block: false }` if the call is fine, or
   * `{ block: false, reason: "..." }` for a warning (first repeat), or
   * `{ block: true, reason: "..." }` to force summary (second+ repeat).
   */
  shouldBlock(
    name: string,
    args: Record<string, unknown>,
  ): { block: boolean; reason?: string | undefined } {
    const sig = this.canonicalize(name, args);
    const count = this.signatureCount.get(sig) ?? 0;

    if (count === 0) return { block: false };

    if (count === 1) {
      return {
        block: false,
        reason: `${name} has already been called with these arguments once. Consider using the results you already have.`,
      };
    }

    // count >= 2: block
    return {
      block: true,
      reason: `${name} was already called ${count} time(s) with the same arguments. Summarize existing results instead.`,
    };
  }

  getAttemptCount(name: string, args: Record<string, unknown>): number {
    const sig = this.canonicalize(name, args);
    return this.signatureCount.get(sig) ?? 0;
  }

  /**
   * Check if recent calls show a pattern of repeated failures
   * (e.g., command not found → retry → not found → ...).
   */
  hasRepeatedFailures(threshold = 3): boolean {
    if (this.attempts.length < threshold) return false;
    const recent = this.attempts.slice(-threshold);
    return recent.every((a) => !a.ok);
  }

  /**
   * Get the total number of recorded attempts.
   */
  get totalAttempts(): number {
    return this.attempts.length;
  }
}
