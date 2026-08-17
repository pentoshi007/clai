import type {
  CompletionRequest,
  ReasoningEffort,
  ReasoningPreference,
} from "../types.js";

/**
 * Gradual reasoning-effort fallback ladder.
 *
 * When a provider rejects a reasoning knob (e.g. `reasoning_effort`), we do
 * not immediately strip reasoning. Instead we walk down the ladder to the
 * nearest commonly-supported effort, and only strip reasoning entirely once
 * every candidate has been rejected. This keeps reasoning quality when the
 * model merely does not support the *highest* requested depth, while still
 * degrading gracefully for models that reject the knob altogether.
 *
 * The ladder is expressed in clai's internal effort levels; the provider's
 * `buildReasoningPayload` maps them onto the wire values it actually accepts.
 */

/** Canonical descending ladder (highest → lowest commonly-supported). */
export const EFFORT_LADDER: readonly ReasoningEffort[] = [
  "xhigh",
  "high",
];

/**
 * Ordered fallback efforts for a rejected `requested` effort, nearest first.
 *
 * Only the extended efforts above "high" have a meaningful fallback: a gateway
 * that rejects "max"/"xhigh" usually still accepts the classic low/medium/high
 * set. Everything else strips reasoning immediately rather than walking a long
 * ladder — a long ladder can loop against a gateway that 503s reasoning-enabled
 * requests (each rung re-triggers the same server error instead of progressing).
 */
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

/**
 * Deduplicated candidate efforts to try, starting with the requested effort
 * and followed by its fallback ladder.
 */
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

/**
 * Detects a provider error that means the model rejected a reasoning *effort*
 * value (as opposed to a transient/network error). Mirrors the stricter
 * wording providers use for "value must be one of …" rejections.
 */
export function isEffortRejectedError(error: unknown): boolean {
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

/**
 * Runs `attempt` once per candidate effort, catching effort-value rejections
 * and moving to the next candidate. Non-effort errors propagate immediately.
 * When every candidate is rejected, the last error is rethrown (the caller's
 * router then strips reasoning entirely).
 */
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
