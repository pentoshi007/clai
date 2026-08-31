import type {
  CompletionRequest,
  ReasoningEffort,
  ReasoningPreference,
} from "../types.js";
import { isMissingReasoningContentError } from "./reasoning-errors.js";


export const EFFORT_LADDER: readonly ReasoningEffort[] = [
  "xhigh",
  "high",
];

export function fallbackEffortsFor(
  requested: ReasoningEffort,
): ReasoningEffort[] {
  const normalized = requested.toLowerCase();
  const nearest: Record<string, ReasoningEffort[]> = {
    max: ["xhigh", "high"],
    xhigh: ["high"],
  };
  return nearest[normalized] ?? [];
}

export function effortCandidates(
  thinking: ReasoningPreference | undefined,
): ReasoningEffort[] {
  const requested = thinking?.effort ?? "medium";
  const seen = new Set<string>();
  const candidates: ReasoningEffort[] = [];
  for (const effort of [requested, ...fallbackEffortsFor(requested)]) {
    const key = effort.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(effort);
  }
  return candidates;
}

export function isEffortRejectedError(error: unknown): boolean {
  if (isMissingReasoningContentError(error)) return false;
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 400 && status !== 422) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  if (
    !/reasoning_effort|\beffort\b|chat_template_kwargs|\bthinking\b/.test(hay)
  ) {
    return false;
  }
  return /must be one of|invalid|unsupported|not support|unknown|unrecognized|not a valid|not allowed|expected one of/.test(
    hay,
  );
}

export async function withEffortFallback<T>(
  request: CompletionRequest,
  attempt: (thinking: CompletionRequest["thinking"]) => Promise<T>,
  onExhausted: () => never,
): Promise<T> {
  if (!request.thinking?.enabled) return await attempt(request.thinking);
  const candidates = effortCandidates(request.thinking);
  let lastError: unknown;
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      return await attempt({ ...request.thinking, effort: candidates[index]! });
    } catch (error) {
      if (!isEffortRejectedError(error)) throw error;
      lastError = error;
      if (index === candidates.length - 1) throw error;
    }
  }
  if (lastError) throw lastError;
  onExhausted();
}
