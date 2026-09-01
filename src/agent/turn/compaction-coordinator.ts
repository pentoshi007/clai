import type {
  ChatMessage,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolDefinition,
} from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { resolveToolDialect } from "../../llm/capabilities.js";
import {
  OperationLedger,
  singleAdmissionOperationPolicy,
} from "../../llm/operation-ledger.js";
import {
  isCompactionMemoryMessage,
  shouldApplyAutoCompact,
} from "../context-manager.js";
import { isOperationPolicyError } from "../../llm/operation-ledger.js";
import { describeDominantContextBlock } from "../context-breakdown.js";
import { planCompactionAdmission } from "./compaction-admission.js";
import { executeAutomaticCompaction } from "./automatic-compaction-execution.js";
import { prepareCompactionCandidateMessages } from "./compaction-candidate.js";
import { measureCompactionFinalFit } from "./compaction-final-fit.js";
import {
  compactionFailureMessage,
  compactionSummaryText,
} from "./compaction-messages.js";
import { selectCompactionReplaySnapshot } from "./compaction-replay-selection.js";
import { repairToolProtocol } from "../tool-history.js";
import type { CompactionExecutionState } from "./compaction-summarizer.js";

export type CompactionAuditPayload = Readonly<
  Record<string, string | number | boolean | undefined>
>;

export interface CompactionAttemptLedger {
  readonly isSuppressed: (key: string) => boolean;
  readonly recordFailure: (key: string) => void;
  readonly recordSuccess: (key: string) => void;
}

export interface CompactionCoordinatorPorts {
  readonly messages: ChatMessage[];
  readonly provider: () => ProviderId;
  readonly model: () => string;
  readonly dialect: () => ReturnType<typeof resolveToolDialect>;
  readonly keepRecent: number;
  readonly contextLimitTokens: () => number | undefined;
  readonly estimateRequestTokens: (messages: readonly ChatMessage[]) => number;
  readonly selectTools: () => ToolDefinition[] | undefined;
  readonly buildDurableEnvelope: () => Promise<string | undefined>;
  readonly attempts: CompactionAttemptLedger;
  readonly executionState: CompactionExecutionState;
  readonly newCompactionId: () => string;
  readonly lastSuccessfulRequestSnapshot: () =>
    SuccessfulRequestSnapshot | undefined;
  readonly clearSuccessfulRequestSnapshot: () => void;
  readonly summarize: Parameters<
    typeof executeAutomaticCompaction
  >[0]["summarize"];
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly instructionsBlock: () => string | undefined;
  readonly skillsBlock: () => string | undefined;
  readonly planApproved: () => boolean;
  readonly resetReadOnlyGuard: () => void;
  readonly refreshSessionState: (plan: SessionPlan | undefined) => void;
  readonly setLastCompactionMsgCount: (count: number) => void;
  readonly writeStarted: (id: string, beforeTokens: number) => void;
  readonly writeFailed: (
    id: string,
    message: string,
    beforeTokens: number,
  ) => void;
  readonly writeCompleted: (
    id: string,
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly audit: (event: string, payload: CompactionAuditPayload) => void;
}

const summaryBodyOf = (messages: readonly ChatMessage[]): string =>
  messages.find((message) => isCompactionMemoryMessage(message))?.content ?? "";

const isAbortLike = (error: Error): boolean =>
  error.name === "AbortError" || error.message.includes("aborted");

interface AdmittedCompaction {
  readonly beforeTokens: number;
  readonly compactTrigger: number;
  readonly durableEnvelope: string | undefined;
  readonly attemptKey: string;
  readonly compactionId: string;
  readonly contextLimitTokens: number | undefined;
  readonly ledger: OperationLedger;
}

const runAdmittedCompaction = async (
  ports: CompactionCoordinatorPorts,
  reason: string,
  force: boolean,
  admitted: AdmittedCompaction,
): Promise<void> => {
  const {
    beforeTokens,
    compactTrigger,
    durableEnvelope,
    attemptKey,
    compactionId,
    contextLimitTokens,
    ledger,
  } = admitted;
  const result = await executeAutomaticCompaction({
    messages: ports.messages,
    summarize: ports.summarize,
    tools: ports.selectTools(),
    provider: ports.provider(),
    model: ports.model(),
    contextLimitTokens,
    keepRecent: ports.keepRecent,
    forceDirectSinglePass: Boolean(ports.executionState.replaySnapshot),
    durableEnvelope,
  });

  if (
    !shouldApplyAutoCompact({
      summarized: result.summarized,
      summaryBody: summaryBodyOf(result.messages),
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      afterMessages: result.messages,
    })
  ) {
    ports.writeFailed(
      compactionId,
      "The generated summary was not accepted; the original context was retained.",
      beforeTokens,
    );
    return;
  }

  const candidateTokens = ports.estimateRequestTokens(result.messages);
  if (!force && candidateTokens >= compactTrigger) {
    const dominant = describeDominantContextBlock(result.messages);
    ports.attempts.recordFailure(attemptKey);
    ports.audit("agent.compact.overflow", {
      reason,
      candidateTokens,
      trigger: compactTrigger,
      dominant,
    });
    ports.notify(
      "warn",
      `context is still ~${candidateTokens.toLocaleString()} tokens after compaction (limit ~${compactTrigger.toLocaleString()}) — largest block: ${dominant}`,
    );
    ports.writeFailed(
      compactionId,
      `Summary remained over the context limit; largest block: ${dominant}.`,
      beforeTokens,
    );
    return;
  }

  const livePlan = await ports.loadPlan();
  const candidateMessages = prepareCompactionCandidateMessages({
    messages: result.messages,
    agentInstructionsBlock: ports.instructionsBlock(),
    activeSkillsBlock: ports.skillsBlock(),
    livePlan,
    planApproved: ports.planApproved(),
  });
  const finalFit = measureCompactionFinalFit({
    provider: ports.provider(),
    model: ports.model(),
    messages: candidateMessages,
    contextLimitTokens,
    selectTools: ports.selectTools,
  });
  if (finalFit?.accounting.overLimit) {
    const dominant = describeDominantContextBlock(candidateMessages);
    ports.attempts.recordFailure(attemptKey);
    ports.audit("agent.compact.overflow", {
      reason,
      candidateTokens: finalFit.accounting.requestTokens,
      safeLimit: finalFit.accounting.limit.effectiveSafeTokens,
      trigger: compactTrigger,
      dominant,
    });
    ports.notify(
      "warn",
      `compacted request would still exceed the effective safe context limit (~${finalFit.accounting.requestTokens.toLocaleString()} > ~${(finalFit.accounting.limit.effectiveSafeTokens ?? 0).toLocaleString()} tokens) — largest block: ${dominant}; run /compact or trim large outputs`,
    );
    ports.writeFailed(
      compactionId,
      `Compacted request would not fit the effective safe context limit; largest block: ${dominant}.`,
      beforeTokens,
    );
    return;
  }

  ports.messages.splice(0, ports.messages.length, ...candidateMessages);
  ports.attempts.recordSuccess(attemptKey);
  ports.resetReadOnlyGuard();
  ports.clearSuccessfulRequestSnapshot();
  ports.refreshSessionState(livePlan);
  ports.setLastCompactionMsgCount(ports.messages.length);

  const afterTokens = ports.estimateRequestTokens(ports.messages);
  ports.audit("agent.compact", {
    newLength: ports.messages.length,
    estimatedTokens: afterTokens,
    reason,
    strategy: result.strategy ?? "single",
    compactionAdmissions: ledger.snapshot().attempts.length,
  });
  ports.writeCompleted(
    compactionId,
    compactionSummaryText(summaryBodyOf(ports.messages)),
    beforeTokens,
    afterTokens,
  );
  ports.notify(
    "info",
    `context auto-compacted to fit the window (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)${result.strategy === "emergency_prefix_slice" ? " — oldest slice only (lower confidence); run /compact for a full summary" : ""}`,
  );
};

export const createCompactionCoordinator =
  (ports: CompactionCoordinatorPorts) =>
  async (reason: string, force = false): Promise<void> => {
    if (repairToolProtocol(ports.messages) > 0) {
      ports.clearSuccessfulRequestSnapshot();
    }
    const contextLimitTokens = ports.contextLimitTokens();
    const admission = await planCompactionAdmission(
      {
        messages: ports.messages,
        provider: ports.provider(),
        model: ports.model(),
        dialect: ports.dialect(),
        keepRecent: ports.keepRecent,
        contextLimitTokens,
        estimateRequestTokens: ports.estimateRequestTokens,
        selectTools: ports.selectTools,
        buildDurableEnvelope: ports.buildDurableEnvelope,
        isSuppressed: ports.attempts.isSuppressed,
      },
      force,
    );
    if (!admission.admitted) return;

    const compactionId = ports.newCompactionId();
    ports.executionState.activeId = compactionId;
    const ledger = new OperationLedger(
      singleAdmissionOperationPolicy("compaction", 3),
    );
    ports.executionState.activeLedger = ledger;
    ports.executionState.replaySnapshot = selectCompactionReplaySnapshot({
      snapshot: ports.lastSuccessfulRequestSnapshot(),
      history: ports.messages,
      provider: ports.provider(),
      model: ports.model(),
      contextLimitTokens,
      durableEnvelope: admission.durableEnvelope,
    });
    ports.writeStarted(compactionId, admission.beforeTokens);

    try {
      await runAdmittedCompaction(ports, reason, force, {
        beforeTokens: admission.beforeTokens,
        compactTrigger: admission.compactTrigger,
        durableEnvelope: admission.durableEnvelope,
        attemptKey: admission.attemptKey,
        compactionId,
        contextLimitTokens,
        ledger,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ports.writeFailed(
        compactionId,
        compactionFailureMessage({
          message,
          policyLimited: isOperationPolicyError(error),
        }),
        admission.beforeTokens,
      );
      if (error instanceof Error && isAbortLike(error)) throw error;
      ports.attempts.recordFailure(admission.attemptKey);
      ports.audit("agent.compact.failed", { reason: message });
    } finally {
      if (ports.executionState.activeId === compactionId) {
        ports.executionState.activeId = undefined;
      }
      if (ports.executionState.activeLedger === ledger) {
        ports.executionState.activeLedger = undefined;
      }
      ports.executionState.replaySnapshot = undefined;
    }
  };
