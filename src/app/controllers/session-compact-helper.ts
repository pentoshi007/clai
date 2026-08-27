/**
 * Summarizer callback used by SessionController.compact (keeps the controller slim).
 */

import type {
  ChatMessage,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import {
  buildDirectCompactionPrompt,
  compactionSinglePassInputBudget,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
} from "../../agent/compaction-summary.js";
import {
  executeCompactionSummary,
  planCompactionReplay,
} from "../../agent/compaction-executor.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  isCompactionMemoryMessage,
  type CompactResult,
} from "../../agent/context-manager.js";
import { calibratedRequestTokens } from "../../llm/token-estimate-calibration.js";
import { modelContextWindow } from "../../llm/token-usage.js";
import {
  OperationLedger,
  singleAdmissionOperationPolicy,
} from "../../llm/operation-ledger.js";
import type {
  AnyAppEvent,
  AppEventPayloads,
} from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";

export async function summarizeForSessionCompact(
  prompt: string,
  opts: {
    provider: ProviderId | undefined;
    model: string | undefined;
    signal?: AbortSignal | undefined;
    /** plan-implement needs denser handoff memory — allow a larger completion. */
    purpose?: "default" | "plan-implement" | undefined;
    stage?: "single" | "map" | "reduce" | undefined;
    sourceMessages?: readonly ChatMessage[] | undefined;
    baseRequest?: SuccessfulRequestSnapshot | undefined;
    history?: readonly ChatMessage[] | undefined;
    contextLimitTokens?: number | undefined;
    operation?: OperationLedger | undefined;
    onToken?: ((token: string, replace?: boolean) => void) | undefined;
  },
): Promise<string> {
  const maxTokens =
    opts.stage === "map"
      ? COMPACTION_MAP_MAX_COMPLETION_TOKENS
      : COMPACTION_MAX_COMPLETION_TOKENS;
  const systemContent =
    opts.purpose === "plan-implement"
      ? "Write concise, non-redundant research memory for an agent executing an approved plan. Do not add framing: the PLAN MODE HANDOFF wrapper and active plan are injected separately. For coding target 600–1000 tokens; preserve only verified state, reusable research/artifacts, decisions, blockers, and risks. Security handoffs may be longer to preserve findings and coverage. Never invent or cut a fact mid-token. You are summarizing, not continuing: never emit tool calls or fabricate tool results, file receipts, or transcript lines."
      : "You compress conversation history into accurate continuation memory. You are SUMMARIZING the past session, not continuing it: do not answer the user, do not perform the next task, and never emit tool calls or fabricate tool results, file-write receipts (bytes/lines/sha256), exit codes, or 'TOOL:'/'[tools: …]' transcript lines. Describe what already happened in your own words.";

  return executeCompactionSummary({
    provider: opts.provider,
    model: opts.model,
    systemContent,
    prompt,
    maxTokens,
    signal: opts.signal,
    ...(opts.sourceMessages ? { sourceMessages: opts.sourceMessages } : {}),
    ...(opts.baseRequest ? { baseRequest: opts.baseRequest } : {}),
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.contextLimitTokens !== undefined
      ? { contextLimitTokens: opts.contextLimitTokens }
      : {}),
    ...(opts.operation ? { operation: opts.operation } : {}),
    stream: Boolean(opts.onToken),
    retryOnServerError: true,
    qualityRetry: false,
    onToken: opts.onToken,
  });
}

interface RunSessionCompactionOptions {
  readonly history: ChatMessage[];
  readonly sessionTranscript?: string | undefined;
  readonly keepRecent: number;
  readonly signal: AbortSignal;
  readonly purpose?: "default" | "plan-implement" | undefined;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly successfulRequest?: SuccessfulRequestSnapshot | undefined;
  readonly contextLimitTokens?: number | undefined;
  /**
   * Current occupancy of the next model request, when the session already has a
   * request-scoped measurement. Reporting against it keeps the manual card on
   * the same scale as the automatic one and as the composer chip.
   */
  readonly requestTokensBefore?: number | undefined;
  readonly persist: boolean;
  readonly compactionId: string;
  readonly sequencer: EventSequencer;
  readonly emit: (event: AnyAppEvent) => void;
  readonly isCurrent: () => boolean;
  readonly commit: (result: CompactResult, reported: ReportedCompaction) => void;
  readonly persistNow: () => Promise<void>;
}

export interface ReportedCompaction {
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly scope: "message-history" | "assembled-request";
}

export async function runSessionCompaction(
  options: RunSessionCompactionOptions,
): Promise<CompactResult> {
  type CompactionEventType =
    | "compaction-started"
    | "compaction-delta"
    | "compaction-completed"
    | "compaction-failed";
  const emit = <T extends CompactionEventType>(
    type: T,
    payload: AppEventPayloads[T],
  ): void => {
    options.emit(
      options.sequencer.build(type, payload, undefined) as AnyAppEvent,
    );
  };

  const historyTokensBefore = estimateMessagesTokens(options.history);
  const successfulRequest = options.successfulRequest;
  const contextLimitTokens =
    options.contextLimitTokens ??
    modelContextWindow(
      successfulRequest?.model ?? options.model,
      successfulRequest?.provider ?? options.provider,
    );
  const instruction = buildDirectCompactionPrompt({
    ...(options.purpose ? { purpose: options.purpose } : {}),
  });
  const replayPlan = successfulRequest
    ? planCompactionReplay({
        baseRequest: successfulRequest,
        history: options.history,
        prompt: instruction,
        maxTokens: COMPACTION_MAX_COMPLETION_TOKENS,
        contextLimitTokens,
        stream: true,
      })
    : undefined;
  const continuationAccounting = replayPlan?.continuationAccounting;
  const snapshotRequestTokensBefore =
    typeof options.requestTokensBefore === "number" &&
    Number.isFinite(options.requestTokensBefore) &&
    options.requestTokensBefore > 0
      ? Math.floor(options.requestTokensBefore)
      : undefined;
  const useContinuationAccounting =
    snapshotRequestTokensBefore === undefined &&
    continuationAccounting !== undefined;
  const requestTokensBefore =
    snapshotRequestTokensBefore ?? continuationAccounting?.requestTokens;
  const scope =
    requestTokensBefore === undefined
      ? "message-history"
      : "assembled-request";
  const beforeTokens = requestTokensBefore ?? historyTokensBefore;
  const reportedFor = (result: CompactResult): ReportedCompaction => {
    const removedHistoryTokens = Math.max(
      0,
      result.beforeTokens - result.afterTokens,
    );
    const afterTokens =
      useContinuationAccounting && continuationAccounting
        ? calibratedRequestTokens(
            successfulRequest?.provider,
            successfulRequest?.model,
            Math.max(
              0,
              continuationAccounting.rawRequestTokens - removedHistoryTokens,
            ),
          )
        : requestTokensBefore === undefined
          ? result.afterTokens
          : Math.max(0, requestTokensBefore - removedHistoryTokens);
    return { beforeTokens, afterTokens, scope };
  };
  if (options.persist) {
    emit("compaction-started", {
      compactionId: options.compactionId,
      beforeTokens,
    });
  }

  let settled = false;
  const operation = new OperationLedger({
    kind: "compaction",
    admissionBudget: 64,
    continuationBudget: 0,
  });
  try {
    if (!successfulRequest) {
      throw new Error(
        "compaction failed: no successful live model request is available for cache-preserving compaction; complete a turn first",
      );
    }
    // Cache-preserving replay: the summary request resends the last
    // successful turn request verbatim with the instruction appended, so the
    // whole prior prompt is served from cache. When that assembled request
    // would not fit (e.g. compacting a nearly-full session), fall back to the
    // legacy transcript-rendered requests rather than failing closed.
    const replay =
      replayPlan && !replayPlan.accounting.overLimit
        ? successfulRequest
        : undefined;
    const result = await compactMessagesWithSummary(
      options.history,
      (prompt, stage) =>
        summarizeForSessionCompact(replay ? instruction : prompt, {
          provider: options.provider,
          model: options.model,
          signal: options.signal,
          purpose: options.purpose,
          stage: stage?.phase,
          ...(replay
            ? {
                baseRequest: replay,
                history: options.history,
                contextLimitTokens,
              }
            : {
                // Legacy path: the direct strategy carries the full source
                // messages; the transcript strategies embed the material in
                // the prompt itself and need no sourceMessages.
                ...(stage?.sourceMessages
                  ? { sourceMessages: stage.sourceMessages }
                  : {}),
              }),
          operation,
          ...(options.persist && stage?.phase !== "map"
            ? {
                onToken: (text: string, replace?: boolean) => {
                  if (options.isCurrent()) {
                    emit("compaction-delta", {
                      compactionId: options.compactionId,
                      text,
                      ...(replace ? { replace: true } : {}),
                    });
                  }
                },
              }
            : {}),
        }),
      {
        budgetTokens: 0,
        keepRecent: options.keepRecent,
        purpose: options.purpose,
        singleAdmission: true,
        ...(replay ? { forceDirectSinglePass: true } : {}),
        singlePassInputBudgetTokens: compactionSinglePassInputBudget(
          contextLimitTokens,
        ),
      },
    );

    if (!options.isCurrent()) return result;
    const reported = reportedFor(result);
    options.commit(result, reported);
    if (options.persist && result.summarized) {
      const summary =
        [...result.messages]
          .reverse()
          .find((message) => isCompactionMemoryMessage(message))?.content ??
        "Compacted context";
      emit("compaction-completed", {
        compactionId: options.compactionId,
        summary,
        beforeTokens: reported.beforeTokens,
        afterTokens: reported.afterTokens,
        contextScope: reported.scope,
      });
    } else if (options.persist) {
      emit("compaction-failed", {
        compactionId: options.compactionId,
        message: "There was no closed history to compact.",
        retainedTokens: beforeTokens,
      });
    }
    if (options.persist) settled = true;
    if (options.persist && result.summarized && result.after !== result.before) {
      await options.persistNow();
    }
    return result;
  } catch (error) {
    if (options.persist && !settled && options.isCurrent()) {
      const message = error instanceof Error ? error.message : String(error);
      emit("compaction-failed", {
        compactionId: options.compactionId,
        message: /aborted/i.test(message) ? "Compaction was cancelled." : message,
        retainedTokens: beforeTokens,
      });
    }
    throw error;
  }
}
