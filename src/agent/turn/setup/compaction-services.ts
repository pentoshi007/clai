import { randomUUID } from "node:crypto";
import type {
  ChatMessage,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolDefinition,
} from "../../../types.js";
import type { ToolDialect } from "../../../llm/tool-protocol.js";
import type { SessionPlan } from "../../../store/plan.js";
import type {
  BackgroundJob,
  ResponderNotification,
} from "../../../tools/jobs.js";
import type { OutcomeEnvelope } from "../../outcomes.js";
import type { WorkLedger } from "../../durable-envelope.js";
import type {
  CompactionExecutionState,
} from "../compaction-summarizer.js";
import type { CompactionAttemptLedger } from "../../compaction-attempt.js";
import { createCompactionSummarizer } from "../compaction-summarizer.js";
import { createCompactionRequestEstimator } from "../compaction-request-estimator.js";
import { createCompactionDurableEnvelopeBuilder } from "../compaction-durable-envelope.js";
import {
  createCompactionCoordinator,
  type CompactionAuditPayload,
} from "../compaction-coordinator.js";

export type CompactionAuditSink = (
  event: string,
  payload: CompactionAuditPayload,
) => void;

export interface CompactionServicesInput {
  readonly messages: ChatMessage[];
  readonly provider: () => ProviderId;
  readonly model: () => string;
  readonly dialect: () => ToolDialect;
  readonly signal: AbortSignal | undefined;
  readonly keepRecent: number;
  readonly sessionId: string;
  readonly outcome: OutcomeEnvelope;
  readonly ledger: WorkLedger;
  readonly attempts: CompactionAttemptLedger;
  readonly executionState: CompactionExecutionState;
  readonly contextLimitTokens: () => number | undefined;
  readonly selectTools: () => ToolDefinition[] | undefined;
  readonly selectToolsForResolvedDialect: () => ToolDefinition[] | undefined;
  readonly loadPlan: () => Promise<SessionPlan | undefined>;
  readonly loadPlanStrict: () => Promise<SessionPlan | undefined>;
  readonly projectRoot: () => string | undefined;
  readonly detectPackageManager: (root: string) => string | undefined;
  readonly pendingNotifications: () => readonly ResponderNotification[];
  readonly runningJobs: () => readonly BackgroundJob[];
  readonly recentJobs: () => readonly BackgroundJob[];
  readonly requestSnapshot: () => SuccessfulRequestSnapshot | undefined;
  readonly clearRequestSnapshot: () => void;
  readonly instructionsBlock: () => string | undefined;
  readonly skillsBlock: () => string | undefined;
  readonly planApproved: () => boolean;
  readonly resetReadOnlyGuard: () => void;
  readonly refreshSessionState: (plan?: SessionPlan | undefined) => void;
  readonly setLastCompactionMsgCount: (count: number) => void;
  readonly writeDelta: (id: string, text: string, replace?: boolean) => void;
  readonly writeStarted: (id: string, beforeTokens: number) => void;
  readonly writeFailed: (
    id: string,
    message: string,
    retainedTokens: number,
  ) => void;
  readonly writeCompleted: (
    id: string,
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ) => void;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly audit: CompactionAuditSink;
}

export interface CompactionServices {
  readonly estimateNextRequestTokens: ReturnType<
    typeof createCompactionRequestEstimator
  >;
  readonly buildDurableEnvelope: ReturnType<
    typeof createCompactionDurableEnvelopeBuilder
  >;
  readonly maybeAutoCompact: ReturnType<typeof createCompactionCoordinator>;
}

export const createCompactionServices = (
  input: CompactionServicesInput,
): CompactionServices => {
  const summarize = createCompactionSummarizer({
    provider: input.provider(),
    model: input.model(),
    signal: input.signal,
    history: input.messages,
    state: input.executionState,
    currentContextLimitTokens: input.contextLimitTokens,
    toolsForSourceMessages: input.selectTools,
    writeDelta: input.writeDelta,
  });

  const estimateNextRequestTokens = createCompactionRequestEstimator({
    provider: input.provider(),
    model: input.model(),
    selectTools: input.selectToolsForResolvedDialect,
  });

  const buildDurableEnvelope = createCompactionDurableEnvelopeBuilder({
    messages: input.messages,
    outcome: input.outcome,
    ledger: input.ledger,
    loadPlan: input.loadPlanStrict,
    getProjectRoot: input.projectRoot,
    detectPackageManager: input.detectPackageManager,
    getUnreadNotificationIds: () =>
      input.pendingNotifications().map((notification) => notification.id),
    getRunningJobs: input.runningJobs,
    getRecentJobs: input.recentJobs,
  });

  const maybeAutoCompact = createCompactionCoordinator({
    messages: input.messages,
    provider: input.provider,
    model: input.model,
    dialect: input.dialect,
    keepRecent: input.keepRecent,
    contextLimitTokens: input.contextLimitTokens,
    estimateRequestTokens: estimateNextRequestTokens,
    selectTools: input.selectTools,
    buildDurableEnvelope,
    attempts: {
      isSuppressed: (key) => input.attempts.isSuppressed(key),
      recordFailure: (key) => input.attempts.recordFailure(key),
      recordSuccess: (key) => input.attempts.recordSuccess(key),
      isExhausted: (key) => input.attempts.isExhausted(key),
    },
    executionState: input.executionState,
    newCompactionId: () => `compact-${randomUUID().slice(0, 12)}`,
    lastSuccessfulRequestSnapshot: input.requestSnapshot,
    clearSuccessfulRequestSnapshot: input.clearRequestSnapshot,
    summarize,
    loadPlan: input.loadPlan,
    instructionsBlock: input.instructionsBlock,
    skillsBlock: input.skillsBlock,
    planApproved: input.planApproved,
    resetReadOnlyGuard: input.resetReadOnlyGuard,
    refreshSessionState: input.refreshSessionState,
    setLastCompactionMsgCount: input.setLastCompactionMsgCount,
    writeStarted: input.writeStarted,
    writeFailed: input.writeFailed,
    writeCompleted: input.writeCompleted,
    notify: input.notify,
    audit: input.audit,
  });

  return { estimateNextRequestTokens, buildDurableEnvelope, maybeAutoCompact };
};
