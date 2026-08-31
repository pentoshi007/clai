import type {
  ChatMessage,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolDefinition,
} from "../../types.js";
import type { OperationLedger } from "../../llm/operation-ledger.js";
import type { CompactionSummaryStage } from "../context-manager.js";
import {
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_SYSTEM_PROMPT,
} from "../compaction-summary.js";
import { executeCompactionSummary } from "../compaction-executor.js";

export interface CompactionExecutionState {
  activeId?: string | undefined;
  activeLedger?: OperationLedger | undefined;
  replaySnapshot?: SuccessfulRequestSnapshot | undefined;
}

export interface CompactionSummarizerPorts {
  readonly provider: ProviderId;
  readonly model: string;
  readonly signal?: AbortSignal | undefined;
  readonly history: ChatMessage[];
  readonly state: CompactionExecutionState;
  readonly currentContextLimitTokens: () => number | undefined;
  readonly toolsForSourceMessages: () => ToolDefinition[] | undefined;
  readonly writeDelta: (id: string, text: string, replace?: boolean) => void;
  readonly execute?: typeof executeCompactionSummary | undefined;
}

const summarize = async (
  ports: CompactionSummarizerPorts,
  summaryPrompt: string,
  stage?: CompactionSummaryStage,
): Promise<string> => {
    const streamFinalSummary = stage?.phase !== "map";
    const compactionId = streamFinalSummary ? ports.state.activeId : undefined;
    const maxTokens =
      stage?.phase === "map"
        ? COMPACTION_MAP_MAX_COMPLETION_TOKENS
        : COMPACTION_MAX_COMPLETION_TOKENS;
    const sourceMessages = stage?.sourceMessages;
    const compactionTools = sourceMessages ? ports.toolsForSourceMessages() : undefined;
    const replay = ports.state.replaySnapshot;
    const contextLimitTokens = ports.currentContextLimitTokens();
    const execute = ports.execute ?? executeCompactionSummary;
    return execute({
      provider: ports.provider,
      model: ports.model,
      systemContent: COMPACTION_SYSTEM_PROMPT,
      prompt: summaryPrompt,
      maxTokens,
      signal: ports.signal,
      ...(replay
        ? {
            baseRequest: replay,
            history: ports.history,
            ...(contextLimitTokens !== undefined ? { contextLimitTokens } : {}),
          }
        : {
            ...(sourceMessages ? { sourceMessages } : {}),
            ...(compactionTools?.length ? { tools: compactionTools } : {}),
          }),
      ...(ports.state.activeLedger ? { operation: ports.state.activeLedger } : {}),
      qualityRetry: false,
      retryOnServerError: true,
      stream: true,
      onToken: compactionId
        ? (text, replace) => ports.writeDelta(compactionId, text, replace)
        : undefined,
  });
};

export const createCompactionSummarizer = (ports: CompactionSummarizerPorts) =>
  (summaryPrompt: string, stage?: CompactionSummaryStage): Promise<string> =>
    summarize(ports, summaryPrompt, stage);
