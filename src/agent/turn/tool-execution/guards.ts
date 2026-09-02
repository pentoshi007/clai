import type { ToolCall } from "../../../types.js";

const NARROW_NMAP_ALLOWED: ReadonlySet<string> = new Set([
  "net.scan",
  "shell.tail",
  "shell.jobs",
  "job.read",
  "task.read",
]);

export interface LoopGuardVerdict {
  readonly block: boolean;
  readonly kind?: string | undefined;
  readonly reason?: string | undefined;
}

export interface ToolGuardInput {
  readonly call: ToolCall;
  readonly narrowNmapOperation: boolean;
  readonly narrowNmapDispatched: number;
  readonly heldBatchReminder: string | undefined;
}

export interface ToolGuardLoopInput {
  readonly verdict: LoopGuardVerdict;
  readonly priorObservation: string | undefined;
}

export type ToolGuardDecision =
  | { readonly kind: "proceed"; readonly consumesNarrowNmapScan: boolean }
  | { readonly kind: "reject"; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "reuse"; readonly reason: string }
  | { readonly kind: "warn-reject"; readonly reason: string }
  | { readonly kind: "loop-reset" };

export interface RetryReason {
  readonly code: string;
  readonly detail: string;
}

export const readRetryReason = (
  args: Record<string, unknown>,
): RetryReason | undefined => {
  const raw = args._retryReason;
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { code?: string; detail?: string };
  return {
    code: String(record.code ?? ""),
    detail: String(record.detail ?? ""),
  };
};

const narrowNmapRejection = (toolName: string): string =>
  `Narrow nmap request: ${toolName} was not run because the user requested only one nmap operation. ` +
  `Call net.scan with the requested target/options; do not create a plan or add DNS, WHOIS, HTTP, recon, or vulnerability steps.`;

const NARROW_NMAP_REPEAT =
  "Narrow nmap request: a scan has already been dispatched this turn. " +
  "Do not broaden or retry it automatically; report the existing result/job status and ask before another scan.";

const checkNarrowNmap = (input: ToolGuardInput): ToolGuardDecision => {
  if (!NARROW_NMAP_ALLOWED.has(input.call.name)) {
    return { kind: "reject", reason: narrowNmapRejection(input.call.name) };
  }
  if (input.call.name === "net.scan") {
    if (input.narrowNmapDispatched >= 1) {
      return { kind: "reject", reason: NARROW_NMAP_REPEAT };
    }
    return { kind: "proceed", consumesNarrowNmapScan: true };
  }
  return { kind: "proceed", consumesNarrowNmapScan: false };
};

export const evaluateToolGuards = (
  input: ToolGuardInput,
): ToolGuardDecision => {
  if (input.narrowNmapOperation) {
    const narrow = checkNarrowNmap(input);
    if (narrow.kind !== "proceed") return narrow;
    if (input.heldBatchReminder !== undefined) {
      return { kind: "hold", reason: input.heldBatchReminder };
    }
    return narrow;
  }
  if (input.heldBatchReminder !== undefined) {
    return { kind: "hold", reason: input.heldBatchReminder };
  }
  return { kind: "proceed", consumesNarrowNmapScan: false };
};

export const evaluateLoopGuardBlock = (
  call: ToolCall,
  loop: ToolGuardLoopInput,
): ToolGuardDecision => {
  if (!loop.verdict.block) return { kind: "proceed", consumesNarrowNmapScan: false };
  const baseReason =
    loop.verdict.reason ??
    `${call.name} previously failed with identical arguments. Change the command/args and retry.`;
  const reason =
    loop.verdict.kind === "unchanged-success" && loop.priorObservation
      ? `${baseReason}\n\nPrior successful result (reuse this; it is the result of the requested call):\n${loop.priorObservation}`
      : baseReason;
  return loop.verdict.kind === "unchanged-success"
    ? { kind: "reuse", reason }
    : { kind: "warn-reject", reason };
};

export const LOOP_RESET_OUTPUT =
  "Loop guard counters reset. You may re-run commands freely.";
