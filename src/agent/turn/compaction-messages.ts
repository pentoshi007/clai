import {
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
} from "../context-manager.js";
import { insertedText } from "./inserted-text.js";

export interface CompactionFailureInput {
  readonly message: string;
  readonly policyLimited: boolean;
}

export const compactionSummaryText = (insertedSummary: string): string =>
  insertedSummary.startsWith(`${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`)
    ? insertedText(insertedSummary, `${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`)
    : insertedSummary.startsWith(`${COMPACTION_MEMORY_PREFIX}\n\n`)
      ? insertedText(insertedSummary, `${COMPACTION_MEMORY_PREFIX}\n\n`)
      : insertedText(
          insertedSummary,
          insertedSummary.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX)
            ? PLAN_IMPLEMENT_MEMORY_PREFIX
            : COMPACTION_MEMORY_PREFIX,
        );

export const compactionFailureMessage = (
  input: CompactionFailureInput,
): string =>
  /aborted/i.test(input.message)
    ? "Compaction was cancelled."
    : input.policyLimited
      ? "Compaction is limited to one pinned request (plus its bounded retry) and none completed; the original context was retained."
      : input.message;
