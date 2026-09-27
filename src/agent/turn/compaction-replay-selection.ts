import type { ChatMessage, ProviderId, SuccessfulRequestSnapshot } from "../../types.js";
import { effectiveContextWindowTokens } from "../../llm/context-windows.js";
import { planCompactionReplay } from "../compaction-executor.js";
import { projectToolHistory } from "../tool-history.js";
import {
  buildDirectCompactionPrompt,
  COMPACTION_MAX_COMPLETION_TOKENS,
} from "../compaction-summary.js";

export interface CompactionReplaySelectionInput {
  readonly snapshot: SuccessfulRequestSnapshot | undefined;
  readonly history: readonly ChatMessage[];
  readonly provider: ProviderId;
  readonly model: string;
  readonly contextLimitTokens: number | undefined;
  readonly durableEnvelope: string | undefined;
}

export const selectCompactionReplaySnapshot = (
  input: CompactionReplaySelectionInput,
): SuccessfulRequestSnapshot | undefined => {
  if (!input.snapshot) return undefined;
  if (projectToolHistory(input.snapshot.messages).changed) return undefined;
  const replayPlan = planCompactionReplay({
    baseRequest: input.snapshot,
    history: input.history,
    prompt: buildDirectCompactionPrompt({
      ...(input.durableEnvelope
        ? { durableState: input.durableEnvelope }
        : {}),
    }),
    maxTokens: COMPACTION_MAX_COMPLETION_TOKENS,
    contextLimitTokens: effectiveContextWindowTokens(
      input.provider,
      input.model,
      input.contextLimitTokens,
    ),
    stream: true,
  });
  return replayPlan && !replayPlan.accounting.overLimit
    ? input.snapshot
    : undefined;
};
