import type {
  CompletionRequest,
  GenerationAttemptReason,
} from "../../types.js";
import { streamAlreadyEmitted } from "../stream-progress.js";

function adaptedRequest(
  request: CompletionRequest,
  error: unknown,
): CompletionRequest | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return;
  if (Number(error.status) !== 400 && Number(error.status) !== 422) return;
  const body = "body" in error ? String(error.body ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  const text = `${message}\n${body}`.toLowerCase();
  if (
    request.toolChoice !== undefined &&
    request.toolChoice !== "auto" &&
    /tool_choice/.test(text) &&
    /only\s+["'`]?auto["'`]?\s+(?:is\s+)?supported|(?:supports?|supported)\s+only\s+["'`]?auto/.test(text)
  ) {
    return request.toolChoice === "none"
      ? {
          ...request,
          tools: undefined,
          toolChoice: undefined,
          parallelToolCalls: undefined,
        }
      : { ...request, toolChoice: "auto" };
  }
  if (
    !/not support|unsupported|unknown|unrecognized|not allowed|not permitted|does not accept/.test(text)
  ) return;
  if (request.parallelToolCalls !== undefined && /parallel_tool_calls/.test(text)) {
    return { ...request, parallelToolCalls: undefined };
  }
  if (request.temperature !== undefined && /\btemperature\b/.test(text)) {
    return { ...request, temperature: undefined };
  }
  return;
}

export async function withRequestOptionFallback<T>(
  request: CompletionRequest,
  reason: GenerationAttemptReason,
  attempt: (
    request: CompletionRequest,
    reason: GenerationAttemptReason,
  ) => Promise<T>,
  canRetry: () => boolean,
  onStatus: ((message: string) => void) | undefined,
): Promise<T> {
  let candidate = request;
  let attemptReason = reason;
  while (true) {
    request.signal?.throwIfAborted();
    try {
      return await attempt(candidate, attemptReason);
    } catch (error) {
      if (!canRetry() || streamAlreadyEmitted(error)) throw error;
      const adapted = adaptedRequest(candidate, error);
      if (!adapted) throw error;
      candidate = adapted;
      attemptReason = "adaptation";
      onStatus?.(
        `ℹ ${request.provider}/${request.model} rejected request options — retrying with compatible options`,
      );
    }
  }
}
