import { randomUUID } from "node:crypto";

import type {
  GenerationAttemptHandle,
  GenerationAttemptInput,
  GenerationAttemptReason,
} from "../types.js";
import {
  OperationUsageRecorder,
  type OperationUsageSnapshot,
} from "./operation-usage.js";

export type OperationKind =
  | "turn"
  | "compaction"
  | "provider_validation"
  | "background";

export type OperationTerminalOutcome =
  | "completed"
  | "failed"
  | "cancelled"
  | "budget-exceeded"
  | "semantic-output-stopped";

export interface OperationPolicy {
  readonly kind: OperationKind;
  readonly admissionBudget: number;
  readonly continuationBudget: number;
}

const DEFAULT_TURN_ADMISSION_BUDGET = 64;

export function turnOperationPolicy(
  admissionBudget: number = DEFAULT_TURN_ADMISSION_BUDGET,
  continuationBudget: number = 0,
): OperationPolicy {
  return Object.freeze({
    kind: "turn" as const,
    admissionBudget,
    continuationBudget,
  });
}

export function singleAdmissionOperationPolicy(
  kind: OperationKind,
  admissionBudget = 1,
): OperationPolicy {
  return Object.freeze({
    kind,
    admissionBudget,
    continuationBudget: 0,
  });
}

interface OperationLedgerIdentity {
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly admissionBudget: number;
  readonly continuationBudget: number;
}

export class OperationAdmissionBudgetExceededError extends Error {
  readonly name = "OperationAdmissionBudgetExceededError";
  readonly operation: OperationLedgerIdentity;

  constructor(operation: OperationLedgerIdentity) {
    super(
      `${operation.kind} operation ${operation.operationId} exhausted its admission budget (${operation.admissionBudget}) before another generation dispatch`,
    );
    this.operation = Object.freeze({ ...operation });
  }
}

export class OperationSemanticOutputError extends Error {
  readonly name = "OperationSemanticOutputError";
  readonly operation: OperationLedgerIdentity;

  constructor(operation: OperationLedgerIdentity) {
    super(
      `${operation.kind} operation ${operation.operationId} already published typed semantic output; transparent regeneration is not allowed`,
    );
    this.operation = Object.freeze({ ...operation });
  }
}

export function isOperationPolicyError(
  error: unknown,
): error is
  | OperationAdmissionBudgetExceededError
  | OperationSemanticOutputError {
  return (
    error instanceof OperationAdmissionBudgetExceededError ||
    error instanceof OperationSemanticOutputError
  );
}

const TRANSPARENT_RETRY_REASONS: ReadonlySet<GenerationAttemptReason> =
  new Set(["retry", "fallback", "adaptation", "provider-retry"]);

export class OperationLedger {
  readonly operationId: string = randomUUID();
  readonly policy: OperationPolicy;

  private readonly recorder: OperationUsageRecorder;
  private admissions = 0;
  private continuations = 0;
  private refusals = 0;
  private semanticOutput = false;
  private terminal: OperationTerminalOutcome | undefined;

  constructor(
    policy: OperationPolicy = turnOperationPolicy(),
    recorder: OperationUsageRecorder = new OperationUsageRecorder(),
  ) {
    this.policy = Object.freeze({ ...policy });
    this.recorder = recorder;
  }

  get kind(): OperationKind {
    return this.policy.kind;
  }

  get admissionsUsed(): number {
    return this.admissions;
  }

  get continuationsUsed(): number {
    return this.continuations;
  }

  get semanticOutputPublished(): boolean {
    return this.semanticOutput;
  }

  /** True once this ledger refused a dispatch the caller tried to make. */
  get admissionRefused(): boolean {
    return this.refusals > 0;
  }

  get terminalOutcome(): OperationTerminalOutcome | undefined {
    return this.terminal;
  }

  begin(input: GenerationAttemptInput): GenerationAttemptHandle {
    if (this.admissions >= this.policy.admissionBudget) {
      this.refusals += 1;
      throw new OperationAdmissionBudgetExceededError(this.identity());
    }
    if (this.semanticOutput && TRANSPARENT_RETRY_REASONS.has(input.reason)) {
      throw new OperationSemanticOutputError(this.identity());
    }
    this.admissions += 1;
    return this.recorder.begin(input);
  }

  noteSemanticOutput(): void {
    this.semanticOutput = true;
  }

  beginContinuation(): void {
    if (this.continuations >= this.policy.continuationBudget) {
      throw new OperationAdmissionBudgetExceededError(this.identity());
    }
    this.continuations += 1;
    this.admissions = 0;
  }

  /**
   * Callers surface the failure that caused the operation to stop, which is the
   * provider error rather than the guard that refused the retry. The ledger
   * still records the budget as the terminal reason so telemetry is not lost.
   */
  settle(outcome: OperationTerminalOutcome): void {
    this.terminal ??=
      outcome === "failed" && this.refusals > 0 ? "budget-exceeded" : outcome;
  }

  snapshot(): OperationUsageSnapshot {
    return this.recorder.snapshot();
  }

  private identity(): OperationLedgerIdentity {
    return {
      operationId: this.operationId,
      kind: this.policy.kind,
      admissionBudget: this.policy.admissionBudget,
      continuationBudget: this.policy.continuationBudget,
    };
  }
}

export function operationTerminalOutcome(
  error: unknown,
  signal?: AbortSignal,
): OperationTerminalOutcome {
  if (error instanceof OperationAdmissionBudgetExceededError) {
    return "budget-exceeded";
  }
  if (error instanceof OperationSemanticOutputError) {
    return "semantic-output-stopped";
  }
  if (signal?.aborted) return "cancelled";
  return "failed";
}

export function operationUsageFromError(
  error: unknown,
): OperationUsageSnapshot | undefined {
  if (!error || typeof error !== "object" || !("operationUsage" in error)) {
    return undefined;
  }
  const snapshot = (error as { operationUsage?: unknown }).operationUsage;
  if (!snapshot || typeof snapshot !== "object") return undefined;
  if (!Array.isArray((snapshot as { attempts?: unknown }).attempts)) {
    return undefined;
  }
  return snapshot as OperationUsageSnapshot;
}
