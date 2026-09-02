import type { ChatMessage, SuccessfulRequestSnapshot } from "../types.js";
import { accountAssembledRequest, SAFETY_MARGIN_TOKENS, type RequestAccounting } from "./request-accounting.js";
import { buildCompactionReplayMessages, comparableMessage, missingHistoryTail } from "./compaction/summary-execution.js";
import { projectToolHistory } from "./tool-history.js";
export { CompactionOverLimitError, executeCompactionSummary, isCompactionOverLimitError } from "./compaction/summary-execution.js";
export { buildCompactionReplayMessages };
export type { CompactionSummaryExecution } from "./compaction/summary-execution.js";

const REPLAY_PLAN_SLACK_TOKENS = 4_096;

export interface CompactionReplayPlan {
  readonly messages: ChatMessage[];
  readonly accounting: RequestAccounting;
  readonly continuationAccounting: RequestAccounting;
}

export function planCompactionReplay(input: {
  readonly baseRequest: SuccessfulRequestSnapshot;
  readonly history: readonly ChatMessage[];
  readonly prompt: string;
  readonly maxTokens: number;
  readonly contextLimitTokens?: number | undefined;
  readonly stream?: boolean | undefined;
}): CompactionReplayPlan | undefined {
  const baseRequest = input.baseRequest;
  if (
    projectToolHistory(baseRequest.messages).changed ||
    projectToolHistory(input.history).changed ||
    baseRequest.messages.some((message) =>
      message.content.includes("[context-note]"),
    ) ||
    input.history.some((message) => message.content.includes("[context-note]"))
  ) {
    return undefined;
  }
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

