import { isHardQuotaError } from "../../llm/quota-signals.js";
import { isModelNotFoundError } from "../../llm/routing/error-classification.js";
import { classifyStreamFailure, type StreamFailureKind } from "../stream-recovery.js";

export type GoalFailureKind = "aborted" | "unrecoverable" | "limited" | "transient";

export interface GoalFailure {
  readonly kind: GoalFailureKind;
  readonly cause: string;
}

const MAX_CAUSE_CHARS = 240;

const EXCERPT_FALLBACK_KINDS: ReadonlySet<StreamFailureKind> = new Set([
  "context-overflow",
  "empty",
  "server",
  "network",
  "stall",
  "unknown",
]);

function causeOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "unknown error");
  const line = raw.split("\n").find((part) => part.trim())?.trim() ?? "unknown error";
  return line.length > MAX_CAUSE_CHARS ? `${line.slice(0, MAX_CAUSE_CHARS - 1)}…` : line;
}

export function classifyGoalFailure(error: unknown): GoalFailure {
  const cause = causeOf(error);
  if (isHardQuotaError(error)) return { kind: "unrecoverable", cause };
  switch (classifyStreamFailure(error)) {
    case "aborted":
      return { kind: "aborted", cause };
    case "auth":
    case "context-overflow":
      return { kind: "unrecoverable", cause };
    case "not-found":
      return { kind: isModelNotFoundError(error) ? "unrecoverable" : "limited", cause };
    case "rate-limit":
    case "content-policy":
    case "non-retriable":
      return { kind: "limited", cause };
    default:
      return { kind: "transient", cause };
  }
}

export function canRetryWithExcerpt(error: unknown): boolean {
  return !isHardQuotaError(error) && EXCERPT_FALLBACK_KINDS.has(classifyStreamFailure(error));
}
