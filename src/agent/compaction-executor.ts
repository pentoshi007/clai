import type { ChatMessage, SuccessfulRequestSnapshot } from "../types.js";
import { accountAssembledRequest, SAFETY_MARGIN_TOKENS, type RequestAccounting } from "./request-accounting.js";
import { buildCompactionReplayMessages, comparableMessage, missingHistoryTail } from "./compaction/summary-execution.js";
export { CompactionOverLimitError, executeCompactionSummary, isCompactionOverLimitError } from "./compaction/summary-execution.js";
export { buildCompactionReplayMessages };
export type { CompactionSummaryExecution } from "./compaction/summary-execution.js";

/**
 * Extra headroom the replay planner adds on top of the standard safety margin.
 * The planner sizes the request with a representative instruction prompt; the
 * real prompt additionally embeds durable-state snippets extracted while the
 * summary runs, so the plan must leave room for them.
 */
const REPLAY_PLAN_SLACK_TOKENS = 4_096;

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

