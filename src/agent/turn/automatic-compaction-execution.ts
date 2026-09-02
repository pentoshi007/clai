import type { ChatMessage, ProviderId, ToolDefinition } from "../../types.js";
import { modelContextWindow } from "../../llm/token-usage.js";
import {
  compactMessagesWithSummary,
  type CompactResult,
  type CompactionSummaryStage,
} from "../context-manager.js";
import { buildContextBreakdown } from "../context-breakdown.js";
import { compactionSinglePassInputBudget } from "../compaction-summary.js";

export interface AutomaticCompactionExecutionInput {
  readonly messages: ChatMessage[];
  readonly summarize: (
    prompt: string,
    stage?: CompactionSummaryStage,
  ) => Promise<string>;
  readonly tools: readonly ToolDefinition[] | undefined;
  readonly provider: ProviderId;
  readonly model: string;
  readonly contextLimitTokens: number | undefined;
  readonly keepRecent: number;
  readonly forceDirectSinglePass: boolean;
  readonly durableEnvelope: string | undefined;
}

export const executeAutomaticCompaction = (
  input: AutomaticCompactionExecutionInput,
): Promise<CompactResult> => {
  const schemaTokens = buildContextBreakdown(
    [],
    input.tools,
  ).estimatedTotalTokens;
  const contextLimit =
    input.contextLimitTokens ?? modelContextWindow(input.model, input.provider);
  return compactMessagesWithSummary(input.messages, input.summarize, {
    budgetTokens: 0,
    keepRecent: input.keepRecent,
    singleAdmission: true,
    ...(input.forceDirectSinglePass ? { forceDirectSinglePass: true } : {}),
    singlePassInputBudgetTokens: Math.max(
      0,
      compactionSinglePassInputBudget(contextLimit) - schemaTokens,
    ),
    ...(input.durableEnvelope
      ? { durableEnvelope: input.durableEnvelope }
      : {}),
  });
};
