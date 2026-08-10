/**
 * Summarizer callback used by SessionController.compact (keeps the controller slim).
 */

import type { ChatMessage, ProviderId } from "../../types.js";
import {
  buildCompactionRetryPrompt,
  compactionSinglePassInputBudget,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
  isCompactionCompletionTruncated,
  looksLikeIncompleteCompactionSummary,
  looksLikeTranscriptReplay,
  normalizeCompactionSummary,
} from "../../agent/compaction-summary.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  isCompactionMemoryMessage,
  type CompactResult,
} from "../../agent/context-manager.js";
import { completeWithProvider, streamWithProvider } from "../../llm/router.js";
import { streamAlreadyEmitted } from "../../llm/stream-progress.js";
import { modelContextWindow } from "../../llm/token-usage.js";
import { createThinkingStreamParser, stripThinking } from "../../ui/thinking.js";
import type {
  AnyAppEvent,
  AppEventPayloads,
} from "../events/app-event.js";
import type { EventSequencer } from "../events/sequencer.js";

function isCompactionServerError(error: unknown): boolean {
  if (streamAlreadyEmitted(error)) return false;
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : 0;
  if (status >= 500 && status <= 504) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /internal server error/i.test(message);
}

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

  const completeSummary = async (
    p: string,
    onToken?: (token: string, replace?: boolean) => void,
  ): Promise<string> => {
    const request = {
      provider: opts.provider,
      model: opts.model,
      messages: opts.sourceMessages
        ? [
            ...opts.sourceMessages,
            { role: "user" as const, content: p },
          ]
        : [
            {
              role: "system" as const,
              content: systemContent,
            },
            { role: "user" as const, content: p },
          ],
      temperature: 0.1,
      maxTokens,
      thinking: { enabled: false, effort: "none" as const },
      signal: opts.signal,
    };
    const runProviderAttempt = async (
      attemptRequest: typeof request,
      replace = false,
    ) => {
      if (!onToken) {
        return completeWithProvider(attemptRequest, { maxRetries: 0 });
      }
      if (replace) onToken("", true);
      const parser = createThinkingStreamParser(
        (text) => onToken(text),
        undefined,
        { remember: false },
      );
      const result = await streamWithProvider(
        attemptRequest,
        (token) => parser.push(token),
        { onStatus: () => undefined, maxRetries: 0 },
      );
      parser.finish();
      return result;
    };
    const runAttempt = async (
      attemptRequest: typeof request,
      replace = false,
    ) => {
      try {
        return await runProviderAttempt(attemptRequest, replace);
      } catch (error) {
        if (!isCompactionServerError(error)) throw error;
        return await runProviderAttempt(attemptRequest, replace);
      }
    };
    const first = await runAttempt(request);
    let visible = normalizeCompactionSummary(
      stripThinking(first.text).visible,
    );
    let retryReason:
      | "truncated"
      | "incomplete"
      | "reasoning-only"
      | "replayed"
      | undefined;
    if (isCompactionCompletionTruncated(first, maxTokens)) {
      retryReason = "truncated";
    } else if (!visible) {
      retryReason = "reasoning-only";
    } else if (looksLikeTranscriptReplay(visible)) {
      retryReason = "replayed";
    } else if (looksLikeIncompleteCompactionSummary(visible)) {
      retryReason = "incomplete";
    }

    if (retryReason) {
      const retry = await runAttempt(
        {
          ...request,
          messages: opts.sourceMessages
            ? [
                ...opts.sourceMessages,
                {
                  role: "user" as const,
                  content: buildCompactionRetryPrompt(p, retryReason),
                },
              ]
            : [
                {
                  role: "system" as const,
                  content: `${systemContent}\nReturn only a complete continuation-memory summary. Do not include analysis, reasoning, or <think> tags.`,
                },
                {
                  role: "user" as const,
                  content: buildCompactionRetryPrompt(p, retryReason),
                },
              ],
          temperature: 0,
          maxTokens,
          thinking: { enabled: false, effort: "none" as const },
        },
        true,
      );
      if (isCompactionCompletionTruncated(retry, maxTokens)) {
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
  };

  // `compactMessagesWithSummary` owns chunking/map-reduce. A second splitting
  // layer here multiplied one /compact into N map calls plus another reduce.
  return completeSummary(prompt, opts.onToken);
}

interface RunSessionCompactionOptions {
  readonly history: ChatMessage[];
  readonly sessionTranscript?: string | undefined;
  readonly keepRecent: number;
  readonly signal: AbortSignal;
  readonly purpose?: "default" | "plan-implement" | undefined;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly persist: boolean;
  readonly compactionId: string;
  readonly sequencer: EventSequencer;
  readonly emit: (event: AnyAppEvent) => void;
  readonly isCurrent: () => boolean;
  readonly commit: (result: CompactResult) => void;
  readonly persistNow: () => Promise<void>;
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

  const beforeTokens = estimateMessagesTokens(options.history);
  if (options.persist) {
    emit("compaction-started", {
      compactionId: options.compactionId,
      beforeTokens,
    });
  }

  let settled = false;
  try {
    const result = await compactMessagesWithSummary(
      options.history,
      (prompt, stage) =>
        summarizeForSessionCompact(prompt, {
          provider: options.provider,
          model: options.model,
          signal: options.signal,
          purpose: options.purpose,
          stage: stage?.phase,
          ...(stage?.sourceMessages
            ? { sourceMessages: stage.sourceMessages }
            : {}),
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
        singlePassInputBudgetTokens: compactionSinglePassInputBudget(
          options.contextLimitTokens ??
            modelContextWindow(options.model, options.provider),
        ),
      },
      options.sessionTranscript,
    );

    if (!options.isCurrent()) return result;
    options.commit(result);
    if (options.persist && result.summarized) {
      const summary =
        [...result.messages]
          .reverse()
          .find((message) => isCompactionMemoryMessage(message))?.content ??
        "Compacted context";
      emit("compaction-completed", {
        compactionId: options.compactionId,
        summary,
        beforeTokens: result.beforeTokens,
        afterTokens: result.afterTokens,
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
