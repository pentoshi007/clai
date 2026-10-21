import type {
  CompletionRequest,
  GenerationAttemptReason,
} from "../../types.js";
import { rememberObservedOutputCap } from "../model-limit-store.js";
import { streamAlreadyEmitted } from "../stream-progress.js";

const MIN_RETRY_OUTPUT_TOKENS = 1_024;
const CONTEXT_FIT_MARGIN_TOKENS = 256;

const MODEL_OUTPUT_CAP_PATTERNS: readonly [RegExp, number][] = [
  [/supports at most (\d+) (?:completion|output) tokens/, 0],
  [/(\d+),? which is the maximum allowed number of output tokens/, 0],
  [/valid range of max_(?:completion_|output_)?tokens is \[\s*\d+\s*,\s*(\d+)\s*\]/, 0],
  [/max_(?:completion_|output_)?tokens`?\s+(?:must be|should be) (?:less than or equal to|<=|at most)\s*`?(\d+)/, 0],
  [/maximum (?:number of )?(?:output |completion )?tokens (?:you can request|allowed) is (\d+)/, 0],
  [/maxoutputtokens value of \d+ but the supported range is from \d+ \(inclusive\) to (\d+) \(exclusive\)/, -1],
];

const CONTEXT_FIT_PATTERNS: readonly RegExp[] = [
  /maximum context length is (\d+) tokens.*?request has (\d+) input tokens/,
  /maximum context length is (\d+) tokens.*?\((\d+) in the messages/,
];

interface OutputTokenRejection {
  readonly maxTokens: number;
  readonly modelCap: boolean;
}

function errorText(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return;
  if (Number(error.status) !== 400 && Number(error.status) !== 422) return;
  const body = "body" in error ? String(error.body ?? "") : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n${body}`.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, "$1");
}

export function outputTokenRejection(error: unknown): OutputTokenRejection | undefined {
  const text = errorText(error);
  if (!text || !/max_(?:completion_|output_)?tokens|maxoutputtokens|output tokens|completion tokens/.test(text)) {
    return undefined;
  }
  for (const [pattern, offset] of MODEL_OUTPUT_CAP_PATTERNS) {
    const match = pattern.exec(text);
    if (match) return { maxTokens: Number(match[1]) + offset, modelCap: true };
  }
  for (const pattern of CONTEXT_FIT_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return {
        maxTokens: Number(match[1]) - Number(match[2]) - CONTEXT_FIT_MARGIN_TOKENS,
        modelCap: false,
      };
    }
  }
  return undefined;
}

function outputTokenAdaptedRequest(
  request: CompletionRequest,
  error: unknown,
): CompletionRequest | undefined {
  if (request.maxTokens === undefined) return undefined;
  const rejection = outputTokenRejection(error);
  if (!rejection || !Number.isFinite(rejection.maxTokens)) return undefined;
  if (rejection.maxTokens < MIN_RETRY_OUTPUT_TOKENS || rejection.maxTokens >= request.maxTokens) {
    return undefined;
  }
  if (rejection.modelCap && request.provider && request.model) {
    rememberObservedOutputCap(request.provider, request.model, rejection.maxTokens);
  }
  return { ...request, maxTokens: rejection.maxTokens };
}

function adaptedRequest(
  request: CompletionRequest,
  error: unknown,
): CompletionRequest | undefined {
  const text = errorText(error);
  if (!text) return;
  const outputAdapted = outputTokenAdaptedRequest(request, error);
  if (outputAdapted) return outputAdapted;
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
      onStatus?.(
        adapted.maxTokens !== candidate.maxTokens
          ? `ℹ ${request.provider}/${request.model} rejected max_tokens ${candidate.maxTokens} — retrying with ${adapted.maxTokens}`
          : `ℹ ${request.provider}/${request.model} rejected request options — retrying with compatible options`,
      );
      candidate = adapted;
      attemptReason = "adaptation";
    }
  }
}
