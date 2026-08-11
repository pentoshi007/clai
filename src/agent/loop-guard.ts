import type { ToolCall } from "../types.js";
import { slimToolArgs } from "./message-slim.js";
import {
  completedOperationObservationDigest,
  completedOperationSignature,
  normalizeOperationArgs,
  type CompletedOperation,
} from "./outcomes.js";

export interface ToolAttempt {
  step: number;
  callName: string;
  canonicalSignature: string;
  ok: boolean;
  exitCode?: number | undefined;
  observationDigest?: string | undefined;
}

const MAX_ATTEMPT_HISTORY = 400;

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
  "wordlist.find",
  "image.ocr",
  "pdf.read",
]);

export interface LoopGuardOptions {
  /** @deprecated Retry authorization belongs in RetryContext passed to shouldBlock. */
  allowUnlimitedFailedRetries?: boolean;
  /** @deprecated Unchanged failed retries are blocked immediately. */
  failedRetryLimit?: number;
}

export interface RetryContext {
  dependenciesChanged?: boolean;
  environmentChanged?: boolean;
  stateKey?: string | undefined;
  retryReason?: {
    code: string;
    detail: string;
  };
}

export interface LoopDecision {
  block: boolean;
  kind?: "failed-retry" | "unchanged-success" | undefined;
  reason?: string | undefined;
}

const SEQUENCE_WARN_THRESHOLD = 2;
const SEQUENCE_BLOCK_THRESHOLD = 2;
const SEQUENCE_REPEAT_WARN_THRESHOLD = 3;
const SEQUENCE_REPEAT_HARD_CAP = 4;

const IMMEDIATE_SEQUENCE_SUPPRESSION_TOOLS = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.replaceLines",
  "fs.append",
  "fs.delete",
  "shell.start",
  "shell.stop",
  "pkg.install",
  "plan.create",
  "task.add",
  "task.move",
  "job.read",
  "task.read",
  "task.update",
  "agent.handoff",
  "loop.reset",
  "terminal.start",
  "terminal.send",
  "terminal.resize",
  "terminal.close",
]);

const UNSAFE_IMMEDIATE_RETRY_TOOLS = new Set([
  "fs.append",
  "shell.start",
  "task.add",
  "agent.handoff",
  "terminal.start",
  "terminal.send",
]);

export interface ActionSequenceDecision {
  suppress: boolean;
  terminal: boolean;
  repetitions: number;
  totalSuppressions: number;
  oscillation: boolean;
  warn: boolean;
  warnMessage?: string | undefined;
}

export class LoopGuard {
  private attempts: ToolAttempt[] = [];
  private signatureCount = new Map<string, number>();
  private signatureSuccess = new Map<string, boolean>();
  private lastActionSequence: string | undefined;
  private lastActionSequenceEligible = false;
  private actionSequenceRepetitions = 0;
  private lastActionSequenceOutcome: string | undefined;
  private unchangedActionSequenceRuns = 0;
  private consecutiveSequenceRepeats = 0;
  private totalSequenceSuppressions = 0;
  private sequenceRunCounts = new Map<string, number>();
  private emptySuccessfulCalls = new Map<
    string,
    { step: number; stateKey?: string | undefined; retryReason?: string | undefined }
  >();
  private failedReadRetryUsed = new Set<string>();
  private successfulOutputs = new Map<string, string>();
  private successfulProbes = new Map<
    string,
    {
      digest: string;
      observation: string;
      unchangedRepeats: number;
      stateKey?: string | undefined;
      compareAfterRestore: boolean;
      retryReason?: string | undefined;
    }
  >();
  private failedProbes = new Map<
    string,
    {
      digest?: string | undefined;
      unchangedRepeats: number;
      stateKey?: string | undefined;
      compareAfterRestore: boolean;
      retryReason?: string | undefined;
    }
  >();
  private lastSuccessfulNonMetaStep = -1;

  constructor(_options: LoopGuardOptions = {}) {}

  restoreCompletedOperations(operations: readonly CompletedOperation[]): void {
    for (const operation of operations) {
      if (operation.ok === false) {
        this.failedProbes.set(operation.signature, {
          ...(operation.observationDigest
            ? { digest: operation.observationDigest }
            : {}),
          unchangedRepeats: operation.unchangedRepeats ?? 0,
          ...(operation.stateKey ? { stateKey: operation.stateKey } : {}),
          compareAfterRestore: true,
        });
        continue;
      }
      if (!operation.observationDigest) continue;
      this.successfulProbes.set(operation.signature, {
        digest: operation.observationDigest,
        observation: operation.observation,
        unchangedRepeats: operation.unchangedRepeats ?? 0,
        ...(operation.stateKey ? { stateKey: operation.stateKey } : {}),
        compareAfterRestore: true,
      });
    }
  }

  canonicalize(name: string, args: Record<string, unknown>): string {
    const slimmed = slimToolArgs(normalizeOperationArgs(name, args));
    if (
      (name === "shell.exec" || name === "shell.start") &&
      typeof slimmed.command === "string"
    ) {
      slimmed.command = slimmed.command.trim().replace(/\s+/g, " ");
    }
    return `${name}::${JSON.stringify(slimmed)}`;
  }

  private sequenceSignature(
    calls: readonly {
      name: string;
      args: Record<string, unknown>;
      stateKey?: string | undefined;
    }[],
  ): string {
    return calls
      .map(
        (call) =>
          `${this.canonicalize(call.name, call.args)}::state=${call.stateKey ?? ""}`,
      )
      .join(" ");
  }

  private callNeedsOutcomeComparison(call: {
    name: string;
    args?: Record<string, unknown>;
  }): boolean {
    if (IMMEDIATE_SEQUENCE_SUPPRESSION_TOOLS.has(call.name)) return false;
    if (call.name !== "tool.batch") return true;
    const children = call.args?.calls;
    if (!Array.isArray(children) || children.length === 0) return false;
    return children.every((child) => {
      if (!child || typeof child !== "object") return false;
      const record = child as Record<string, unknown>;
      return (
        typeof record.name === "string" &&
        this.callNeedsOutcomeComparison({
          name: record.name,
          args:
            record.args && typeof record.args === "object"
              ? (record.args as Record<string, unknown>)
              : {},
        })
      );
    });
  }

  private sequenceNeedsOutcomeComparison(
    calls: readonly { name: string; args?: Record<string, unknown> }[],
  ): boolean {
    return calls.every((call) => this.callNeedsOutcomeComparison(call));
  }

  private callHasUnsafeImmediateRetry(call: {
    name: string;
    args?: Record<string, unknown>;
  }): boolean {
    if (UNSAFE_IMMEDIATE_RETRY_TOOLS.has(call.name)) return true;
    if (call.name !== "tool.batch") return false;
    const children = call.args?.calls;
    if (!Array.isArray(children)) return true;
    return children.some((child) => {
      if (!child || typeof child !== "object") return true;
      const record = child as Record<string, unknown>;
      if (typeof record.name !== "string") return true;
      return this.callHasUnsafeImmediateRetry({
        name: record.name,
        args:
          record.args && typeof record.args === "object"
            ? (record.args as Record<string, unknown>)
            : {},
      });
    });
  }

  observeActionSequence(
    calls: readonly {
      name: string;
      args: Record<string, unknown>;
      stateKey?: string | undefined;
    }[],
  ): ActionSequenceDecision {
    const none: ActionSequenceDecision = {
      suppress: false,
      terminal: false,
      repetitions: 0,
      totalSuppressions: this.totalSequenceSuppressions,
      oscillation: false,
      warn: false,
    };
    if (calls.length === 0) {
      this.lastActionSequence = undefined;
      this.lastActionSequenceEligible = false;
      this.actionSequenceRepetitions = 0;
      this.lastActionSequenceOutcome = undefined;
      this.unchangedActionSequenceRuns = 0;
      this.consecutiveSequenceRepeats = 0;
      return none;
    }
    const signature = this.sequenceSignature(calls);
    const currentCount = this.sequenceRunCounts.get(signature) ?? 0;

    if (signature !== this.lastActionSequence) {
      this.lastActionSequence = signature;
      this.lastActionSequenceEligible = false;
      this.actionSequenceRepetitions = 0;
      this.lastActionSequenceOutcome = undefined;
      this.unchangedActionSequenceRuns = 0;
      this.consecutiveSequenceRepeats = 0;
      return none;
    }

    if (!this.lastActionSequenceEligible) {
      return none;
    }

    this.consecutiveSequenceRepeats += 1;

    if (this.sequenceNeedsOutcomeComparison(calls)) {
      if (this.unchangedActionSequenceRuns < 2) {
        if (this.consecutiveSequenceRepeats < SEQUENCE_REPEAT_WARN_THRESHOLD) {
          return none;
        }
        if (this.consecutiveSequenceRepeats < SEQUENCE_REPEAT_HARD_CAP) {
          return {
            suppress: false,
            terminal: false,
            repetitions: this.consecutiveSequenceRepeats,
            totalSuppressions: this.totalSequenceSuppressions,
            oscillation: false,
            warn: true,
            warnMessage:
              `You have emitted this exact action sequence (same tools, same arguments) ${this.consecutiveSequenceRepeats + 1} times in consecutive responses. ` +
              "If you are genuinely iterating (e.g. re-running a test after edits), call loop.reset before repeating it again; otherwise use the existing results or take a materially different action. " +
              "Further identical repetitions will be blocked.",
          };
        }
      } else if (this.unchangedActionSequenceRuns === 2) {
        return {
          suppress: false,
          terminal: false,
          repetitions: 2,
          totalSuppressions: this.totalSequenceSuppressions,
          oscillation: false,
          warn: true,
          warnMessage:
            "This exact observable action has produced the same result twice consecutively. " +
            "The comparison run will proceed. If further identical runs are intentional, call loop.reset before repeating it again; otherwise use the existing result or change approach.",
        };
      }
    }

    this.actionSequenceRepetitions += 1;
    const totalReps = currentCount + 1;

    if (totalReps >= SEQUENCE_BLOCK_THRESHOLD) {
      this.totalSequenceSuppressions += 1;
      return {
        suppress: true,
        terminal:
          this.actionSequenceRepetitions >= (calls.length > 1 ? 2 : 3) ||
          this.totalSequenceSuppressions >= 4,
        repetitions: this.actionSequenceRepetitions,
        totalSuppressions: this.totalSequenceSuppressions,
        oscillation: false,
        warn: false,
      };
    }

    if (totalReps >= SEQUENCE_WARN_THRESHOLD) {
      return {
        suppress: false,
        terminal: false,
        repetitions: this.actionSequenceRepetitions,
        totalSuppressions: this.totalSequenceSuppressions,
        oscillation: false,
        warn: true,
        warnMessage:
          `You have run this exact action sequence ${totalReps} times this session. ` +
          "Make sure you are not stuck in a loop repeating the same command without making progress. " +
          "If you are receiving output and genuinely iterating (e.g. testing after edits), call loop.reset to reset the counter and continue. " +
          `Commands will be blocked after ${SEQUENCE_BLOCK_THRESHOLD} repetitions.`,
      };
    }

    return none;
  }

  completeActionSequence(
    calls: readonly {
      name: string;
      args: Record<string, unknown>;
      stateKey?: string | undefined;
    }[],
    eligible: boolean,
    outcomeFingerprint?: string | undefined,
  ): void {
    if (calls.length === 0) return;
    const signature = this.sequenceSignature(calls);
    if (signature !== this.lastActionSequence) return;
    this.lastActionSequenceEligible = eligible;
    if (!eligible) {
      this.actionSequenceRepetitions = 0;
      this.lastActionSequenceOutcome = undefined;
      this.unchangedActionSequenceRuns = 0;
      return;
    }
    if (this.sequenceNeedsOutcomeComparison(calls)) {
      const comparableOutcome = outcomeFingerprint ?? "__no-outcome__";
      const unchanged = comparableOutcome === this.lastActionSequenceOutcome;
      this.unchangedActionSequenceRuns = unchanged
        ? this.unchangedActionSequenceRuns + 1
        : 1;
      this.lastActionSequenceOutcome = comparableOutcome;
    }
    this.sequenceRunCounts.set(signature, (this.sequenceRunCounts.get(signature) ?? 0) + 1);
  }

  resetSequenceCount(
    calls: readonly {
      name: string;
      args: Record<string, unknown>;
      stateKey?: string | undefined;
    }[],
  ): boolean {
    if (calls.length === 0) return false;
    const signature = this.sequenceSignature(calls);
    return this.resetSequenceCountBySignature(signature);
  }

  resetSequenceCountBySignature(signature: string): boolean {
    if (!this.sequenceRunCounts.has(signature)) return false;
    this.sequenceRunCounts.delete(signature);
    this.actionSequenceRepetitions = 0;
    this.consecutiveSequenceRepeats = 0;
    return true;
  }

  resetAllSequenceCounts(): void {
    this.sequenceRunCounts.clear();
    this.actionSequenceRepetitions = 0;
    this.consecutiveSequenceRepeats = 0;
    this.lastActionSequenceOutcome = undefined;
    this.unchangedActionSequenceRuns = 0;
    this.totalSequenceSuppressions = 0;
    this.lastActionSequence = undefined;
    this.lastActionSequenceEligible = false;
    this.signatureCount.clear();
    this.signatureSuccess.clear();
    this.emptySuccessfulCalls.clear();
    this.failedReadRetryUsed.clear();
    this.successfulProbes.clear();
    this.failedProbes.clear();
  }

  getSequenceRunCount(
    calls: readonly {
      name: string;
      args: Record<string, unknown>;
      stateKey?: string | undefined;
    }[],
  ): number {
    if (calls.length === 0) return 0;
    return this.sequenceRunCounts.get(this.sequenceSignature(calls)) ?? 0;
  }

  currentActionSequenceSignature(): string | undefined {
    return this.lastActionSequence;
  }

  recordAttempt(
    step: number,
    name: string,
    args: Record<string, unknown>,
    ok: boolean,
    exitCode?: number | undefined,
    output?: string | undefined,
    context?: RetryContext | undefined,
  ): void {
    const sig = this.canonicalize(name, args);
    const observationDigest =
      output !== undefined
        ? completedOperationObservationDigest(name, output)
        : undefined;
    this.attempts.push({
      step,
      callName: name,
      canonicalSignature: sig,
      ok,
      exitCode,
      ...(observationDigest ? { observationDigest } : {}),
    });
    if (this.attempts.length > MAX_ATTEMPT_HISTORY) {
      this.attempts.splice(0, this.attempts.length - MAX_ATTEMPT_HISTORY);
    }
    this.signatureCount.set(sig, (this.signatureCount.get(sig) ?? 0) + 1);
    if (ok) {
      this.signatureSuccess.set(sig, true);
      if (output?.trim()) {
        this.successfulOutputs.delete(sig);
        this.successfulOutputs.set(sig, output.trim().slice(0, 8_000));
        if (this.successfulOutputs.size > MAX_ATTEMPT_HISTORY) {
          const oldest = this.successfulOutputs.keys().next().value;
          if (oldest !== undefined) this.successfulOutputs.delete(oldest);
        }
      }
      if (name !== "task.update" && name !== "plan.create") {
        this.lastSuccessfulNonMetaStep = step;
      }
      if (output === undefined || output.trim()) {
        this.emptySuccessfulCalls.delete(sig);
      } else if (name !== "task.update" && name !== "plan.create") {
        this.emptySuccessfulCalls.set(sig, {
          step,
          ...(context?.stateKey ? { stateKey: context.stateKey } : {}),
        });
      }
    } else {
      if (!this.signatureSuccess.has(sig)) this.signatureSuccess.set(sig, false);
    }

    const probeSignature = completedOperationSignature(name, args);
    if (ok && output !== undefined && probeSignature) {
      const digest = completedOperationObservationDigest(name, output);
      const prior = this.successfulProbes.get(probeSignature);
      const unchanged =
        prior?.digest === digest && prior.stateKey === context?.stateKey;
      this.successfulProbes.set(probeSignature, {
        digest,
        observation: output.trim().slice(0, 8_000),
        unchangedRepeats: unchanged ? (prior?.unchangedRepeats ?? 0) + 1 : 0,
        ...(context?.stateKey ? { stateKey: context.stateKey } : {}),
        compareAfterRestore: false,
        ...(prior?.retryReason ? { retryReason: prior.retryReason } : {}),
      });
    }

    if (probeSignature) {
      if (ok) {
        this.failedProbes.delete(probeSignature);
      } else {
        const priorFailure = this.failedProbes.get(probeSignature);
        const unchanged =
          observationDigest !== undefined &&
          priorFailure?.digest === observationDigest &&
          priorFailure.stateKey === context?.stateKey;
        this.failedProbes.set(probeSignature, {
          ...(observationDigest ? { digest: observationDigest } : {}),
          unchangedRepeats: unchanged
            ? (priorFailure?.unchangedRepeats ?? 0) + 1
            : 0,
          ...(context?.stateKey ? { stateKey: context.stateKey } : {}),
          compareAfterRestore: false,
          ...(priorFailure?.retryReason
            ? { retryReason: priorFailure.retryReason }
            : {}),
        });
      }
    }

    if (ok && this.isPathMutatingTool(name)) {
      this.successfulProbes.clear();
      this.invalidateReadsAfterSuccess(name, args);
    }
  }

  private isPathMutatingTool(name: string): boolean {
    return (
      name === "fs.write" ||
      name === "fs.writeMany" ||
      name === "fs.edit" ||
      name === "fs.replaceLines" ||
      name === "fs.append" ||
      name === "fs.delete" ||
      name === "shell.exec" ||
      name === "shell.start"
    );
  }

  private invalidateReadsAfterSuccess(
    name: string,
    args: Record<string, unknown>,
  ): void {
    const paths: string[] = [];
    if (typeof args.path === "string") paths.push(args.path);
    if (name === "fs.writeMany" && Array.isArray(args.files)) {
      for (const f of args.files) {
        if (
          f &&
          typeof f === "object" &&
          typeof (f as { path?: string }).path === "string"
        ) {
          paths.push((f as { path: string }).path);
        }
      }
    }
    if (
      (name === "shell.exec" || name === "shell.start") &&
      typeof args.command === "string"
    ) {
      const cmd = args.command;
      for (const m of cmd.matchAll(
        /(?:mkdir\s+(?:-p\s+)?|cd\s+|create-[\w@./-]+\s+|vite@\S+\s+)(['"]?)([^\s;'"]+)\1/gi,
      )) {
        if (m[2] && m[2] !== ".") paths.push(m[2]);
      }
      if (typeof args.cwd === "string") paths.push(args.cwd);
    }
    if (paths.length === 0) return;
    for (const sig of [...this.signatureCount.keys()]) {
      if (!sig.startsWith("fs.read::") && !sig.startsWith("fs.list::")) continue;
      if (paths.some((p) => p.length > 1 && sig.includes(p))) {
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
        this.successfulOutputs.delete(sig);
        this.failedReadRetryUsed.delete(sig);
      }
    }
  }

  getPriorObservation(name: string, args: Record<string, unknown>): string | undefined {
    const direct = this.successfulOutputs.get(this.canonicalize(name, args));
    if (direct) return direct;
    const probeSignature = completedOperationSignature(name, args);
    return probeSignature
      ? this.successfulProbes.get(probeSignature)?.observation
      : undefined;
  }

  private hasInterveningAttempt(signature: string): boolean {
    const latest = this.attempts.at(-1);
    return latest !== undefined && latest.canonicalSignature !== signature;
  }

  private hasRepeatedEquivalentAttempt(
    signature: string,
    ok: boolean,
  ): boolean {
    const latest = this.attempts.at(-1);
    const previous = this.attempts.at(-2);
    return Boolean(
      latest &&
        previous &&
        latest.canonicalSignature === signature &&
        previous.canonicalSignature === signature &&
        latest.ok === ok &&
        previous.ok === ok &&
        latest.exitCode === previous.exitCode &&
        latest.observationDigest === previous.observationDigest,
    );
  }

  private hasThreeEquivalentAttempts(
    signature: string,
    ok: boolean,
  ): boolean {
    const latest = this.attempts.at(-1);
    const previous = this.attempts.at(-2);
    const earlier = this.attempts.at(-3);
    return Boolean(
      latest &&
        previous &&
        earlier &&
        latest.canonicalSignature === signature &&
        previous.canonicalSignature === signature &&
        earlier.canonicalSignature === signature &&
        latest.ok === ok &&
        previous.ok === ok &&
        earlier.ok === ok &&
        latest.exitCode === previous.exitCode &&
        previous.exitCode === earlier.exitCode &&
        latest.observationDigest === previous.observationDigest &&
        previous.observationDigest === earlier.observationDigest,
    );
  }

  shouldBlock(
    name: string,
    args: Record<string, unknown>,
    retryContext?: RetryContext,
  ): LoopDecision {
    if (name === "task.update" || name === "plan.create") {
      return { block: false };
    }

    const sig = this.canonicalize(name, args);
    const emptySuccess = this.emptySuccessfulCalls.get(sig);
    if (emptySuccess) {
      if (
        retryContext?.stateKey !== undefined &&
        retryContext.stateKey !== emptySuccess.stateKey
      ) {
        return { block: false };
      }
      if (
        this.hasInterveningAttempt(sig) ||
        (emptySuccess.stateKey === undefined &&
          this.lastSuccessfulNonMetaStep > emptySuccess.step)
      ) {
        return { block: false };
      }
      if (
        this.callNeedsOutcomeComparison({ name, args }) &&
        !this.hasThreeEquivalentAttempts(sig, true)
      ) {
        return { block: false };
      }
      const retryReason = retryContext?.retryReason;
      const reasonKey =
        retryReason?.code.trim() && retryReason.detail.trim()
          ? `${retryReason.code.trim()}\0${retryReason.detail.trim()}`
          : undefined;
      if (reasonKey && reasonKey !== emptySuccess.retryReason) {
        emptySuccess.retryReason = reasonKey;
        return { block: false };
      }
      return {
        block: true,
        kind: "unchanged-success",
        reason:
          `${name} completed with an empty result and identical arguments. ` +
          "Do not repeat it unchanged; use a different action, wait for an observable state change, or provide one new structured retry reason.",
      };
    }

    const latestAttempt = this.attempts.at(-1);
    if (
      !this.callNeedsOutcomeComparison({ name, args }) &&
      latestAttempt?.canonicalSignature === sig &&
      latestAttempt.ok
    ) {
      return {
        block: true,
        kind: "unchanged-success",
        reason:
          `${name} already completed with identical arguments. ` +
          "Do not replay the exact same side effect without changing its arguments.",
      };
    }

    const probeSignature = completedOperationSignature(name, args);
    const probe = probeSignature
      ? this.successfulProbes.get(probeSignature)
      : undefined;
    if (probe) {
      if (probe.compareAfterRestore) {
        probe.compareAfterRestore = false;
        return { block: false };
      }
      if (
        retryContext?.stateKey !== undefined &&
        retryContext.stateKey !== probe.stateKey
      ) {
        return { block: false };
      }
      if (this.hasInterveningAttempt(sig)) {
        return { block: false };
      }
      if (probe.unchangedRepeats < 2) {
        return { block: false };
      }
      const retryReason = retryContext?.retryReason;
      const reasonKey =
        retryReason?.code.trim() && retryReason.detail.trim()
          ? `${retryReason.code.trim()}\0${retryReason.detail.trim()}`
          : undefined;
      if (reasonKey && reasonKey !== probe.retryReason) {
        probe.retryReason = reasonKey;
        return { block: false };
      }
      return {
        block: true,
        kind: "unchanged-success",
        reason:
          `${name} already completed with identical arguments and no observed state change. ` +
          "Reuse the prior observation; choose a different action unless the job state, arguments, or retry reason changes.",
      };
    }

    const restoredFailure = probeSignature
      ? this.failedProbes.get(probeSignature)
      : undefined;
    if (restoredFailure) {
      if (
        retryContext?.dependenciesChanged === true ||
        retryContext?.environmentChanged === true ||
        (retryContext?.stateKey !== undefined &&
          retryContext.stateKey !== restoredFailure.stateKey)
      ) {
        return { block: false };
      }
      if (this.hasInterveningAttempt(sig)) {
        return { block: false };
      }
      if (restoredFailure.compareAfterRestore) {
        restoredFailure.compareAfterRestore = false;
        return { block: false };
      }
      if (restoredFailure.unchangedRepeats < 1) {
        return { block: false };
      }
      if (READ_ONLY_TOOLS.has(name) && !this.failedReadRetryUsed.has(sig)) {
        const lastFailStep = [...this.attempts]
          .reverse()
          .find((attempt) => attempt.canonicalSignature === sig && !attempt.ok)?.step;
        if (
          lastFailStep !== undefined &&
          this.lastSuccessfulNonMetaStep > lastFailStep
        ) {
          this.failedReadRetryUsed.add(sig);
          return { block: false };
        }
      }
      const retryReason = retryContext?.retryReason;
      const reasonKey =
        retryReason?.code.trim() && retryReason.detail.trim()
          ? `${retryReason.code.trim()}\0${retryReason.detail.trim()}`
          : undefined;
      if (reasonKey && reasonKey !== restoredFailure.retryReason) {
        restoredFailure.retryReason = reasonKey;
        return { block: false };
      }
      return {
        block: true,
        kind: "failed-retry",
        reason:
          `${name} previously failed with identical arguments, including in an interrupted turn. ` +
          "Change the command/args, fix the environment, or provide one new structured retry reason.",
      };
    }

    const count = this.signatureCount.get(sig) ?? 0;
    if (count === 0 || this.hasInterveningAttempt(sig)) return { block: false };

    if (this.signatureSuccess.get(sig) !== false) {
      return { block: false };
    }

    const structuredReason = retryContext?.retryReason;
    const authorized =
      retryContext?.dependenciesChanged === true ||
      retryContext?.environmentChanged === true ||
      Boolean(
        structuredReason?.code.trim() && structuredReason.detail.trim(),
      );
    if (authorized) {
      return { block: false };
    }
    if (this.callHasUnsafeImmediateRetry({ name, args })) {
      return {
        block: true,
        kind: "failed-retry",
        reason:
          `${name} failed with identical arguments and may have partially delivered its side effect. ` +
          "Do not replay it without changed arguments or an explicit structured retry reason.",
      };
    }
    if (READ_ONLY_TOOLS.has(name) && !this.failedReadRetryUsed.has(sig)) {
      const lastFailStep = [...this.attempts]
        .reverse()
        .find((a) => a.canonicalSignature === sig && !a.ok)?.step;
      if (
        lastFailStep !== undefined &&
        this.lastSuccessfulNonMetaStep > lastFailStep
      ) {
        this.failedReadRetryUsed.add(sig);
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
        return { block: false };
      }
    }
    if (!this.hasRepeatedEquivalentAttempt(sig, false)) {
      return { block: false };
    }
    return {
      block: true,
      kind: "failed-retry",
      reason: `${name} previously failed with identical arguments. Change the command/args, fix the environment, or provide a structured retry reason.`,
    };
  }

  getAttemptCount(name: string, args: Record<string, unknown>): number {
    const sig = this.canonicalize(name, args);
    return this.signatureCount.get(sig) ?? 0;
  }

  hasRepeatedFailures(threshold = 3): boolean {
    if (this.attempts.length < threshold) return false;
    const recent = this.attempts.slice(-threshold);
    return recent.every((a) => !a.ok);
  }

  consecutiveFailureCount(): number {
    let count = 0;
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      if (!this.attempts[i]!.ok) count++;
      else break;
    }
    return count;
  }

  getFailureReflection(): string | null {
    const consecutiveFailures = this.consecutiveFailureCount();
    if (consecutiveFailures < 3) return null;

    const recentFails = this.attempts.slice(-consecutiveFailures);
    const toolSummary = recentFails
      .map((a) => `  - ${a.callName}: ${a.canonicalSignature.slice(0, 120)}`)
      .slice(-5)
      .join("\n");

    const severity = consecutiveFailures >= 6 ? "CRITICAL" : "WARNING";

    return `⚠ APPROACH EVALUATION REQUIRED (${severity}) — ${consecutiveFailures} consecutive tool calls have FAILED.

Recent failures:
${toolSummary}

You MUST now pause and evaluate:
1. Are these failures all related to the SAME approach/method? If yes, this approach may not be viable.
2. Is there a DIFFERENT approach that could work? (different tool, different protocol, different technique)
3. Or is this a series of unrelated small issues that are being fixed incrementally?

DECIDE one of:
- CONTINUE: if you're making real progress and each failure teaches you something new
- SWITCH: describe the new approach before trying it
- STOP: if you've exhausted viable approaches — tell the user honestly what you tried and why it didn't work

Do NOT keep trying variations of the same failing approach without explicitly deciding to SWITCH or STOP first.`;
  }

  resetReadOnly(): void {
    for (const sig of [...this.signatureCount.keys()]) {
      const name = sig.split("::")[0] ?? "";
      if (READ_ONLY_TOOLS.has(name)) {
        this.signatureCount.delete(sig);
        this.signatureSuccess.delete(sig);
        this.successfulOutputs.delete(sig);
      }
    }
    this.attempts = this.attempts.filter(
      (a) => !READ_ONLY_TOOLS.has(a.callName),
    );
  }

  get totalAttempts(): number {
    return this.attempts.length;
  }
}
