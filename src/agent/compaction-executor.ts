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

const COMPACTION_THINKING = {
  enabled: false,
  effort: "low" as const,
};

function cloneTextOnlyMessage(message: ChatMessage): ChatMessage {
  const clone = structuredClone(message);
  delete clone.images;
  return clone;
}

function cloneCompatibilityMessage(message: ChatMessage): ChatMessage {
  const clone = cloneTextOnlyMessage(message);
  delete clone.reasoningBlock;
  delete clone.reasoningArtifacts;
  return clone;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = Number((error as { status?: unknown }).status);
  return Number.isFinite(status) ? status : undefined;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: unknown }).body ?? "")
      : "";
  return `${message}\n${body}`.trim();
}

function isRequestShapeRejection(error: unknown, signal?: AbortSignal): boolean {
  if (streamAlreadyEmitted(error) || isAbortError(error, signal)) return false;
  const status = errorStatus(error);
  if (status !== 400 && status !== 422) return false;
  const text = errorText(error);
  return !/context length|maximum context|context window|prompt too long|too many tokens|model (?:is )?not found|unknown model|content policy|safety policy|moderation|unauthori[sz]ed|api key/i.test(
    text,
  );
}

const REJECTABLE_WIRE_FIELDS = [
  "chat_template_kwargs",
  "enable_thinking",
  "reasoning_effort",
  "reasoning_budget",
  "reasoning_content",
  "parallel_tool_calls",
  "tool_choice",
  "stream_options",
  "max_completion_tokens",
  "max_tokens",
  "temperature",
  "top_p",
  "image_url",
  "images",
  "tools",
  "thinking",
  "reasoning",
] as const;

function rejectedWireField(error: unknown): string | undefined {
  const text = errorText(error)
    .toLowerCase()
    .replace(
      /\(e\.g\.\s*images? on a text-only model\)/g,
      "",
    );
  const rejection =
    "not support|unsupported|unknown|unrecognized|not allowed|does not accept|extra inputs are not permitted|invalid(?: request)?(?: argument| parameter| field| value)?";
  for (const field of REJECTABLE_WIRE_FIELDS) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      new RegExp(`(?:${escaped}).{0,80}(?:${rejection})`, "i").test(text) ||
      new RegExp(`(?:${rejection}).{0,80}(?:${escaped})`, "i").test(text)
    ) {
      return field;
    }
  }
  return undefined;
}

interface CompatibilityRequest {
  readonly request: CompletionRequest;
  readonly removed: readonly string[];
}

function compactionCompatibilityRequest(
  request: CompletionRequest,
): CompatibilityRequest | undefined {
  const removed: string[] = [];
  if (request.thinking !== undefined || request.forceReasoningReplay) {
    removed.push("reasoning controls");
  }
  if (
    request.tools?.length ||
    request.toolChoice !== undefined ||
    request.parallelToolCalls !== undefined
  ) {
    removed.push("tool controls");
  }
  let removedArtifacts = false;
  const messages = request.messages.map((message) => {
    if (message.reasoningBlock || message.reasoningArtifacts?.length) {
      removedArtifacts = true;
    }
    return cloneCompatibilityMessage(message);
  });
  if (removedArtifacts) removed.push("reasoning replay artifacts");
  if (removed.length === 0) return undefined;

  const {
    thinking: _thinking,
    forceReasoningReplay: _forceReasoningReplay,
    tools: _tools,
    toolChoice: _toolChoice,
    parallelToolCalls: _parallelToolCalls,
    ...rest
  } = request;
  return {
    request: {
      ...rest,
      messages,
    },
    removed,
  };
}

function requestRejectionError(input: {
  readonly error: unknown;
  readonly retried: boolean;
  readonly removed?: readonly string[] | undefined;
}): Error {
  const field = rejectedWireField(input.error);
  const upstream = errorText(input.error).replace(/\s+/g, " ").trim();
  const cappedUpstream =
    upstream.length > 600 ? `${upstream.slice(0, 600)}…` : upstream;
  const retry = input.retried
    ? ` after one compatibility retry${input.removed?.length ? ` without ${input.removed.join(", ")}` : ""}`
    : "";
  const diagnosis = field
    ? `The provider identified \`${field}\` as the rejected field.`
    : "No image payload was sent, and the provider did not identify which request field was invalid; any image example in its generic message is not evidence that this request contained an image.";
  const wrapped = new Error(
    `compaction failed: the provider rejected the text-only summary request${retry}. ${diagnosis} The original context was retained.${cappedUpstream ? ` Provider response: ${cappedUpstream}` : ""}`,
    { cause: input.error },
  );
  const status = errorStatus(input.error);
  if (status !== undefined) {
    Object.defineProperty(wrapped, "status", {
      configurable: true,
      enumerable: true,
      value: status,
    });
  }
  return wrapped;
}

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
  textOnly = true,
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
  return history
    .slice(matchedHistory)
    .map((message) =>
      textOnly ? cloneTextOnlyMessage(message) : structuredClone(message),
    );
}

/**
 * Cache-preserving compaction history: the last successful request's text and
 * protocol timeline, any appended history, then the compaction instruction.
 * Binary image payloads are deliberately omitted from this text operation.
 */
export function buildCompactionReplayMessages(
  baseRequest: SuccessfulRequestSnapshot,
  history: readonly ChatMessage[],
  userPrompt: string,
): ChatMessage[] {
  return [
    ...baseRequest.messages.map(cloneTextOnlyMessage),
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
    ...missingHistoryTail(baseRequest.messages, input.history, false),
  ];
  const messages = buildCompactionReplayMessages(
    baseRequest,
    input.history,
    input.prompt,
  );
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
          ...execution.sourceMessages.map(cloneTextOnlyMessage),
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
          thinking: COMPACTION_THINKING,
          ...(execution.allowModelFallback ? { allowModelFallback: true } : {}),
          ...(execution.tools?.length
            ? {
                tools: execution.tools.map((tool) => structuredClone(tool)),
                toolChoice: "none" as const,
              }
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

  const runTransientAttempt = async (
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

  const runAttempt = async (
    attemptRequest: CompletionRequest,
    replace = false,
  ) => {
    try {
      return await runTransientAttempt(attemptRequest, replace);
    } catch (error) {
      if (!isRequestShapeRejection(error, execution.signal)) throw error;
      const compatibility = compactionCompatibilityRequest(attemptRequest);
      if (!compatibility) {
        throw requestRejectionError({ error, retried: false });
      }
      try {
        return await runTransientAttempt(compatibility.request);
      } catch (retryError) {
        if (!isRequestShapeRejection(retryError, execution.signal)) {
          throw retryError;
        }
        throw requestRejectionError({
          error: retryError,
          retried: true,
          removed: compatibility.removed,
        });
      }
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
