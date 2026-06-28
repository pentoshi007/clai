import type { ToolCall } from "../types.js";

export interface ToolAttempt {
  step: number;
  callName: string;
  canonicalSignature: string;
  ok: boolean;
  exitCode?: number | undefined;
}

/**
 * Non-mutating tools that may legitimately need re-calling after context
 * compaction removes their earlier results. These get a higher dedup
 * threshold (3 vs 2 for write tools) and their counters can be reset when
 * context is compacted.
 */
const READ_ONLY_TOOLS = new Set([
  "web.fetch",
  "http.fetch",
  "web.search",
  "dns.lookup",
  "whois.lookup",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "net.context",
  "tool.check",
  "image.ocr",
  "pdf.read",
]);

/**
 * Track and detect tool-call repetition patterns so the agent doesn't
 * waste steps in loops.
 */
export class LoopGuard {
  private attempts: ToolAttempt[] = [];
  private signatureCount = new Map<string, number>();
  private signatureSuccess = new Map<string, boolean>();

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
    // Remember whether this exact call has EVER succeeded. A call that only
    // ever failed should be allowed to retry (e.g. fs.write that hit ENOENT,
    // a command that needed installing first) without being flagged as a
    // redundant loop.
    if (ok) this.signatureSuccess.set(sig, true);
    else if (!this.signatureSuccess.has(sig)) this.signatureSuccess.set(sig, false);
  }

  /**
   * Check whether the proposed call should be blocked as a repeat.
   *
   * Returns `{ block: false }` if the call is fine, or
   * `{ block: false, reason: "..." }` for a warning (first repeat), or
   * `{ block: true, reason: "..." }` to force summary (second+ repeat).
   *
   * A call whose every prior attempt FAILED is never blocked — the model is
   * expected to fix the cause (install a tool, create a dir) and retry. Only
   * calls that already SUCCEEDED are deduped, since re-running them wastes a
   * step and risks an infinite summarize loop.
   *
   * Read-only tools (web.fetch, fs.read, etc.) get a higher threshold (3)
   * because they may legitimately need re-calling after context compaction
   * removes their results.
   */
  shouldBlock(
    name: string,
    args: Record<string, unknown>,
  ): { block: boolean; reason?: string | undefined } {
    const sig = this.canonicalize(name, args);
    const count = this.signatureCount.get(sig) ?? 0;

    if (count === 0) return { block: false };

    // Prior attempts all failed → allow the retry, no warning.
    if (this.signatureSuccess.get(sig) === false) return { block: false };

    // Mutating file tools deserve tool-appropriate wording. Telling a model
    // that just wrote a file to "use the results you already have" is
    // nonsensical and has caused models to assume the whole task is done.
    const isWrite =
      name === "fs.write" || name === "fs.writeMany" || name === "fs.edit";

    // Read-only tools get a higher threshold — they may need re-calling
    // after context compaction removes their earlier results.
    const threshold = READ_ONLY_TOOLS.has(name) ? 3 : 2;

    if (count < threshold) {
      return {
        block: false,
        reason: isWrite
          ? `${name} already wrote this exact path/content once. If that file is finished, move on to the NEXT file or step — do NOT rewrite it.`
          : `${name} has already been called with these arguments once and succeeded. Consider using the results you already have.`,
      };
    }

    // count >= threshold and at least one success: block
    return {
      block: true,
      reason: isWrite
        ? `${name} was already called ${count} time(s) with the identical path and content. That file is already written. Continue with the remaining files/steps or give your final answer.`
        : `${name} was already called ${count} time(s) with the same arguments. The data is already in your context — analyze what you have and move to the next step.`,
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
   * Reset counters for read-only tools. Called after context compaction
   * so the model can re-fetch data whose results were compacted away.
   */
  resetReadOnly(): void {
    for (const sig of [...this.signatureCount.keys()]) {
      const name = sig.split("::")[0] ?? "";
      if (READ_ONLY_TOOLS.has(name)) {
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
      }
    }
    this.attempts = this.attempts.filter(
      (a) => !READ_ONLY_TOOLS.has(a.callName),
    );
  }

  /**
   * Get the total number of recorded attempts.
   */
  get totalAttempts(): number {
    return this.attempts.length;
  }
}

