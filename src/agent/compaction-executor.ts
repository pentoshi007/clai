import type {
  ChatMessage,
  CompletionRequest,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../types.js";
import {
  buildCompactionRetryPrompt,
  isCompactionCompletionTruncated,
  looksLikeIncompleteCompactionSummary,
  looksLikeTranscriptReplay,
  normalizeCompactionSummary,
} from "./compaction-summary.js";
import { completeWithProvider, streamWithProvider } from "../llm/router.js";
import type { OperationLedger } from "../llm/operation-ledger.js";
import { streamAlreadyEmitted } from "../llm/stream-progress.js";
import { createThinkingStreamParser, stripThinking } from "../ui/thinking.js";
import {
  accountAssembledRequest,
  RequestOverLimitError,
  SAFETY_MARGIN_TOKENS,
  type RequestAccounting,
} from "./request-accounting.js";
import { isAbortError } from "./session-policy.js";

const RETRY_SYSTEM_SUFFIX =
  "\nReturn only a complete continuation-memory summary. Do not include analysis, reasoning, or <think> tags.";

/**
 * Pause between a failed compaction admission and its retry: the failure is
 * almost always transient upstream capacity (5xx, 429, a 200 whose stream
 * errored), and an instant replay just re-hits the same hot route.
 */
const COMPACTION_ERROR_RETRY_DELAY_MS = 1_500;

/**
 * Extra headroom the replay planner adds on top of the standard safety margin.
 * The planner sizes the request with a representative instruction prompt; the
 * real prompt additionally embeds durable-state snippets extracted while the
 * summary runs, so the plan must leave room for them.
 */
const REPLAY_PLAN_SLACK_TOKENS = 4_096;

/**
 * A compaction failure worth one more admission. Retryable by default: the
 * only failures excluded are ones a retry cannot fix — aborts, partial streams
 * (re-sending would double-print the summary card), fit-check rejections (the
 * request is deterministically too large), and definitive request errors (4xx
 * other than 408/429). Everything else is treated as transient: 5xx, 429/408,
 * network resets, idle timeouts, and gateway responses that returned HTTP 200
 * but failed upstream mid-stream.
 */
function isCompactionRetryableError(error: unknown, signal?: AbortSignal): boolean {
  if (streamAlreadyEmitted(error)) return false;
  if (isAbortError(error, signal)) return false;
  if (isCompactionOverLimitError(error)) return false;
  if (error instanceof RequestOverLimitError) return false;
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : 0;
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/** The assembled snapshot-replay request cannot fit the effective safe limit. */
export class CompactionOverLimitError extends Error {
  constructor(
    message: string,
    readonly requestTokens: number,
    readonly effectiveSafeTokens: number | undefined,
  ) {
    super(message);
    this.name = "CompactionOverLimitError";
  }
}

export function isCompactionOverLimitError(
  error: unknown,
): error is CompactionOverLimitError {
  return error instanceof CompactionOverLimitError;
}

export interface CompactionSummaryExecution {
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly systemContent: string;
  readonly prompt: string;
  readonly maxTokens: number;
  readonly signal?: AbortSignal | undefined;
  readonly sourceMessages?: readonly ChatMessage[] | undefined;
  readonly baseRequest?: SuccessfulRequestSnapshot | undefined;
  readonly history?: readonly ChatMessage[] | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly tools?: CompletionRequest["tools"] | undefined;
  readonly allowModelFallback?: boolean | undefined;
  readonly stream: boolean;
  readonly retryOnServerError?: boolean | undefined;
  /** Backoff before the error retry; defaults to COMPACTION_ERROR_RETRY_DELAY_MS. */
  readonly retryDelayMs?: number | undefined;
  readonly qualityRetry?: boolean | undefined;
  readonly operation?: OperationLedger | undefined;
  readonly onToken?:
    | ((text: string, replace?: boolean) => void)
    | undefined;
}

const FAIL_CLOSED_BY_REASON = {
  truncated: "compaction failed: model hit the summary output limit — original context retained",
  "reasoning-only":
    "compaction failed: model returned no visible summary — original context retained",
  replayed:
    "compaction failed: model replayed the transcript — original context retained",
  incomplete:
    "compaction failed: model returned an incomplete summary — original context retained",
} as const;

function comparableMessage(message: ChatMessage): string {
  const { images: _images, ...rest } = message;
  return JSON.stringify(rest);
}

function missingHistoryTail(
  requestMessages: readonly ChatMessage[],
  history: readonly ChatMessage[],
): ChatMessage[] {
  let requestIndex = 0;
  let matchedHistory = 0;
  while (matchedHistory < history.length) {
    const expected = comparableMessage(history[matchedHistory]!);
    let found = -1;
    for (let index = requestIndex; index < requestMessages.length; index += 1) {
      if (comparableMessage(requestMessages[index]!) === expected) {
        found = index;
        break;
      }
    }
    if (found < 0) break;
    requestIndex = found + 1;
    matchedHistory += 1;
  }
  return history.slice(matchedHistory).map((message) => structuredClone(message));
}

/**
 * The cache-preserving compaction request: the exact messages of the last
 * successful turn request, any history messages appended since, then the
 * compaction instruction as the final user turn. The previous prompt is a
 * strict prefix of this request, so APC providers serve it entirely from
 * cache and only the tail + instruction bill as fresh input.
 */
export function buildCompactionReplayMessages(
  baseRequest: SuccessfulRequestSnapshot,
  history: readonly ChatMessage[],
  userPrompt: string,
): ChatMessage[] {
  return [
    ...baseRequest.messages.map((message) => structuredClone(message)),
    ...missingHistoryTail(baseRequest.messages, history),
    { role: "user" as const, content: userPrompt },
  ];
}

export interface CompactionReplayPlan {
  readonly messages: ChatMessage[];
  readonly accounting: RequestAccounting;
  readonly continuationAccounting: RequestAccounting;
}

/**
 * Pre-flight the snapshot-replay request without dispatching it. Returns
 * undefined when the snapshot is not a usable prefix base for the live
 * history; otherwise the replay messages and their serialized-request
 * accounting, so the caller can pick the cache-preserving strategy only when
 * the request actually fits (`!plan.accounting.overLimit`). The accounting
 * reserves the summary completion budget and adds planner slack for the
 * durable-state detail the final instruction prompt gains later.
 *
 * Replay compatibility: identical heads are the common case (the snapshot was
 * captured from this session's live message array). History restored from
 * disk drops the composed system head, so a headless history is accepted when
 * its messages still match into the snapshot's body. Anything else means the
 * snapshot belongs to a different lineage (provider/model switch, rewound or
 * replaced history) and replaying it would resurrect dropped messages.
 */
export function planCompactionReplay(input: {
  readonly baseRequest: SuccessfulRequestSnapshot;
  readonly history: readonly ChatMessage[];
  readonly prompt: string;
  readonly maxTokens: number;
  readonly contextLimitTokens?: number | undefined;
  readonly stream?: boolean | undefined;
}): CompactionReplayPlan | undefined {
  const baseRequest = input.baseRequest;
  const snapshotHead = baseRequest.messages[0];
  const historyHead = input.history[0];
  if (!snapshotHead || !historyHead) return undefined;
  const tail = missingHistoryTail(baseRequest.messages, input.history);
  if (comparableMessage(snapshotHead) !== comparableMessage(historyHead)) {
    if (historyHead.role === "system") return undefined;
    if (tail.length >= input.history.length) return undefined;
  }
  const continuationMessages: ChatMessage[] = [
    ...baseRequest.messages.map((message) => structuredClone(message)),
    ...tail,
  ];
  const messages: ChatMessage[] = [
    ...continuationMessages,
    { role: "user" as const, content: input.prompt },
  ];
  const account = (
    candidateMessages: readonly ChatMessage[],
    compactionRequest: boolean,
  ): RequestAccounting =>
    accountAssembledRequest({
      provider: baseRequest.provider,
      model: baseRequest.model,
      messages: candidateMessages,
      stream: input.stream ?? true,
      ...(baseRequest.tools?.length ? { tools: baseRequest.tools } : {}),
      ...(baseRequest.toolChoice !== undefined
        ? { toolChoice: baseRequest.toolChoice }
        : {}),
      ...(baseRequest.parallelToolCalls !== undefined
        ? { parallelToolCalls: baseRequest.parallelToolCalls }
        : {}),
      ...(baseRequest.thinking ? { reasoning: baseRequest.thinking } : {}),
      ...(input.contextLimitTokens !== undefined
        ? { contextLimitTokens: input.contextLimitTokens }
        : {}),
      ...(compactionRequest
        ? {
            reservedOutputTokens: input.maxTokens,
            safetyMarginTokens:
              SAFETY_MARGIN_TOKENS + REPLAY_PLAN_SLACK_TOKENS,
          }
        : {}),
    }).accounting;
  return {
    messages,
    accounting: account(messages, true),
    continuationAccounting: account(continuationMessages, false),
  };
}

export async function executeCompactionSummary(
  execution: CompactionSummaryExecution,
): Promise<string> {
  const attemptMessages = (
    userPrompt: string,
    systemContent: string,
  ): ChatMessage[] => {
    if (execution.baseRequest) {
      return buildCompactionReplayMessages(
        execution.baseRequest,
        execution.history ?? [],
        userPrompt,
      );
    }
    return execution.sourceMessages
      ? [
          ...execution.sourceMessages,
          { role: "user" as const, content: userPrompt },
        ]
      : [
          { role: "system" as const, content: systemContent },
          { role: "user" as const, content: userPrompt },
        ];
  };

  const baseRequest = execution.baseRequest;
  const request: CompletionRequest = {
    provider: baseRequest?.provider ?? execution.provider,
    model: baseRequest?.model ?? execution.model,
    purpose: "compaction",
    messages: attemptMessages(execution.prompt, execution.systemContent),
    maxTokens: execution.maxTokens,
    ...(baseRequest
      ? {
          ...(baseRequest.temperature !== undefined
            ? { temperature: baseRequest.temperature }
            : {}),
          ...(baseRequest.thinking
            ? { thinking: structuredClone(baseRequest.thinking) }
            : {}),
          ...(baseRequest.tools
            ? { tools: baseRequest.tools.map((tool) => structuredClone(tool)) }
            : {}),
          ...(baseRequest.toolChoice !== undefined
            ? { toolChoice: structuredClone(baseRequest.toolChoice) }
            : {}),
          ...(baseRequest.parallelToolCalls !== undefined
            ? { parallelToolCalls: baseRequest.parallelToolCalls }
            : {}),
        }
      : {
          temperature: 0.1,
          // Disable reasoning for the compression pass. Use "low" (not "none"):
          // for openai-style gateways (TokenRouter etc.) `effort:"none"` maps to
          // the wire value `reasoning_effort:"none"`, which many models reject
          // ("reasoning option not supported"). "low" with enabled:false maps to
          // no reasoning knob on those gateways while still disabling default
          // thinking on deepseek-style models via their own mapping.
          thinking: { enabled: false, effort: "low" as const },
          ...(execution.allowModelFallback ? { allowModelFallback: true } : {}),
          ...(execution.tools?.length
            ? { tools: execution.tools, toolChoice: "none" as const }
            : {}),
        }),
    ...(execution.signal ? { signal: execution.signal } : {}),
  };

  if (baseRequest) {
    const accounting = accountAssembledRequest({
      provider: baseRequest.provider,
      model: baseRequest.model,
      messages: request.messages,
      stream: execution.stream,
      ...(request.tools?.length ? { tools: request.tools } : {}),
      ...(request.toolChoice !== undefined
        ? { toolChoice: request.toolChoice }
        : {}),
      ...(request.parallelToolCalls !== undefined
        ? { parallelToolCalls: request.parallelToolCalls }
        : {}),
      ...(request.thinking ? { reasoning: request.thinking } : {}),
      ...(execution.contextLimitTokens !== undefined
        ? { contextLimitTokens: execution.contextLimitTokens }
        : {}),
      reservedOutputTokens: execution.maxTokens,
    }).accounting;
    if (accounting.overLimit) {
      throw new CompactionOverLimitError(
        `compaction failed: captured request plus compaction instruction needs about ${accounting.requestTokens.toLocaleString()} input tokens but only ${accounting.limit.effectiveSafeTokens?.toLocaleString()} fit after reserving summary output — original context retained`,
        accounting.requestTokens,
        accounting.limit.effectiveSafeTokens,
      );
    }
  }

  const runProviderAttempt = async (
    attemptRequest: CompletionRequest,
    replace = false,
  ) => {
    // A pinned single dispatch is what makes the one-admission contract real:
    // without it the router can still rotate keys, fall back to another
    // provider, or retry a capability downgrade, each resending this prompt.
    const routerOptions = {
      maxRetries: 0,
      singleDispatch: true,
      ...(execution.operation ? { operation: execution.operation } : {}),
    };
    if (!execution.stream) {
      return completeWithProvider(attemptRequest, routerOptions);
    }
    if (replace) execution.onToken?.("", true);
    const parser = createThinkingStreamParser(
      (text) => execution.onToken?.(text),
      undefined,
      { remember: false },
    );
    const result = await streamWithProvider(
      attemptRequest,
      (token) => parser.push(token),
      { onStatus: () => undefined, ...routerOptions },
    );
    parser.finish();
    return result;
  };

  const sleepBeforeRetry = async (): Promise<void> => {
    const delayMs = execution.retryDelayMs ?? COMPACTION_ERROR_RETRY_DELAY_MS;
    if (delayMs <= 0) return;
    if (execution.signal?.aborted) {
      throw execution.signal.reason ?? new Error("Aborted");
    }
    await new Promise<void>((resolve, reject) => {
      const signal = execution.signal;
      const timer = setTimeout(() => {
        cleanup();
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        reject(signal?.reason ?? new Error("Aborted"));
      };
      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  // One automatic retry after a transient failure: the replayed prefix is
  // cache-hot, so the second admission only re-bills the small fresh tail.
  const runAttempt = async (
    attemptRequest: CompletionRequest,
    replace = false,
  ) => {
    try {
      return await runProviderAttempt(attemptRequest, replace);
    } catch (error) {
      if (
        !execution.retryOnServerError ||
        !isCompactionRetryableError(error, execution.signal)
      ) {
        throw error;
      }
      await sleepBeforeRetry();
      return await runProviderAttempt(attemptRequest, replace);
    }
  };

  const first = await runAttempt(request);
  if (first.toolCalls?.length) {
    throw new Error(
      "compaction failed: model returned tool calls instead of a summary — original context retained",
    );
  }
  let visible = normalizeCompactionSummary(
    stripThinking(first.text).visible,
  );
  let retryReason:
    | "truncated"
    | "incomplete"
    | "reasoning-only"
    | "replayed"
    | undefined;
  if (isCompactionCompletionTruncated(first, execution.maxTokens)) {
    retryReason = "truncated";
  } else if (!visible) {
    retryReason = "reasoning-only";
  } else if (looksLikeTranscriptReplay(visible)) {
    retryReason = "replayed";
  } else if (looksLikeIncompleteCompactionSummary(visible)) {
    retryReason = "incomplete";
  }

  if (retryReason) {
    if (execution.qualityRetry === false) {
      throw new Error(FAIL_CLOSED_BY_REASON[retryReason]);
    }
    const retry = await runAttempt(
      {
        ...request,
        messages: attemptMessages(
          buildCompactionRetryPrompt(execution.prompt, retryReason),
          `${execution.systemContent}${RETRY_SYSTEM_SUFFIX}`,
        ),
        temperature: 0,
      },
      true,
    );
    if (retry.toolCalls?.length) {
      throw new Error(
        "compaction failed: model returned tool calls instead of a summary — original context retained",
      );
    }
    if (isCompactionCompletionTruncated(retry, execution.maxTokens)) {
      throw new Error(
        "compaction failed: model hit the summary output limit twice — original context retained",
      );
    }
    visible = normalizeCompactionSummary(
      stripThinking(retry.text).visible,
    );
    if (!visible) {
      throw new Error("compaction failed: model returned an empty summary");
    }
    if (looksLikeTranscriptReplay(visible)) {
      throw new Error(
        "compaction failed: model replayed the transcript twice — original context retained",
      );
    }
    if (looksLikeIncompleteCompactionSummary(visible)) {
      throw new Error(
        "compaction failed: model returned an incomplete summary twice — original context retained",
      );
    }
  }

  return visible;
}
