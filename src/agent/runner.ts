import chalk from "chalk";

import { join } from "node:path";
import type {
  ChatMessage,
  ChatImage,
  Mode,
  NativeToolCall,
  ProviderId,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../types.js";
import { completeWithProvider, streamWithProvider } from "../llm/router.js";
import { modelContextWindow } from "../llm/token-usage.js";
import { streamAlreadyEmitted } from "../llm/stream-progress.js";
import {
  classifyStreamFailure,
  planStreamRecovery,
  recordRecoveryAttempt,
  createStreamRecoveryState,
  resetStreamRecoveryState,
} from "./stream-recovery.js";
import { modelSupportsVision, resolveToolDialect } from "../llm/capabilities.js";
import {
  syntheticToolCallId,
  isTextOnlyModel,
  markTextOnlyModel,
  fromWireName,
} from "../llm/tool-protocol.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../ui-core/rendering/sanitize-display.js";
import { createHash, randomUUID } from "node:crypto";
import {
  jobManager,
  type BackgroundJob,
  type ResponderNotification,
} from "../tools/jobs.js";
import {
  isResponderResultLedgerMessage,
  responderContextMessage,
  upsertResponderContextMessage,
  upsertResponderResultLedger,
} from "./responder-context.js";
import {
  agentModeDirective,
  planModeDirective,
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
  renderRequestEnvironmentContext,
  scratchDirFor,
  toolNudge,
} from "../prompts/index.js";
import { getConfig, getProviderModel } from "../store/config.js";
import {
  beginSessionWorkspace,
  getActiveSessionWorkspace,
} from "../store/session-workspace.js";
import { groqInputTokenBudget } from "../llm/groq.js";
import {
  classifyToolCall,
  isPentestToolCall,
  scopeHint,
  scopeTargetForToolCall,
} from "../safety/classifier.js";

/**
 * Scope/engagement classification runs on every tool call and parses
 * model-supplied arguments (URLs, hosts, commands). A malformed argument must
 * never throw out of classification and abort the whole turn — degrade to
 * "no target / no action" so the normal permission path still applies.
 */
function safeScopeTargetForToolCall(call: ToolCall): string | undefined {
  try {
    return scopeTargetForToolCall(call);
  } catch {
    return undefined;
  }
}

function safeEngagementActionsForToolCall(
  call: ToolCall,
): ReturnType<typeof engagementActionsForToolCall> {
  try {
    return engagementActionsForToolCall(call);
  } catch {
    return [];
  }
}
import {
  availableToolNames,
  normalizeToolCall,
  runToolCall,
  BATCH_SAFE_TOOLS,
} from "../tools/registry.js";
import {
  getToolDefinitions,
  getCompactToolDefinitions,
  RUNNER_META_TOOL_NAMES,
} from "../tools/definitions.js";
import {
  elidedStubReuseMessage,
  findElidedStubArg,
} from "./message-slim.js";
import {
  appendAssistantWithTools,
  ensureUniqueToolCallIds,
  toolCallIdsInHistory,
  appendToolResult,
  assertValidToolProtocol,
  fillMissingToolResults,
  repairToolProtocol,
} from "./tool-history.js";
import {
  compactMessagesWithSummary,
  estimateTokens,
  estimateMessagesTokens,
  shouldApplyAutoCompact,
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
  isCompactionMemoryMessage,
  type CompactionSummaryStage,
} from "./context-manager.js";
import {
  buildContextBreakdown,
  contextBreakdownAuditPayload,
  describeDominantContextBlock,
  toolSchemaHash,
} from "./context-breakdown.js";
import {
  autoCompactTriggerTokens,
  dedupeToolContextOutput,
  freeTierGuardNotices,
  getReliabilityPolicy,
  resolveStepMaxTokens,
} from "./reliability-policy.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
  stripThinking,
} from "../ui/thinking.js";
import {
  hasReasoningMarker,
  REASONING_CLOSE,
  REASONING_OPEN,
} from "../llm/reasoning-marker.js";
import { safeCwd } from "../os/cwd.js";
import {
  analyzeTask,
  formatTaskAnalysisHint,
  isNarrowExplicitNmapOperation,
} from "./task-analyzer.js";
import { computeMaxIterations, computeStepBudget } from "./step-budget.js";
import { isScratchOnlyWrite } from "./scratch-write.js";
import {
  buildDurableEnvelope,
  WorkLedger,
  type EnvelopeJobState,
} from "./durable-envelope.js";
import {
  buildCompactionRetryPrompt,
  compactionSinglePassInputBudget,
  COMPACTION_SYSTEM_PROMPT,
  COMPACTION_MAX_COMPLETION_TOKENS,
  COMPACTION_MAP_MAX_COMPLETION_TOKENS,
  isCompactionCompletionTruncated,
  looksLikeIncompleteCompactionSummary,
  looksLikeTranscriptReplay,
  normalizeCompactionSummary,
} from "./compaction-summary.js";
import {
  maybeAppendPlanModeReminder,
  PLAN_REMINDER_TOAST,
} from "./plan-mode-reminders.js";
import { LoopGuard } from "./loop-guard.js";
import {
  appendInterruptedReasoning,
  interruptedReasoningBrief,
  isMeaningfulResumptionYield,
} from "./interrupted-reasoning.js";
import {
  CompactionAttemptLedger,
  compactionAttemptKey,
} from "./compaction-attempt.js";
import {
  loadPlan,
  savePlan,
  mutatePlan,
  markTask,
  appendPlanTask,
  type PlanTask,
  readyPlanTasks,
  foregroundRemaining,
  responderOpenTasks,
  isPlanTerminal,
  isPlanSuccessful,
  type SessionPlan,
  type TaskEvidence,
} from "../store/plan.js";
import type { AgentEvent } from "./events.js";
import { stat } from "node:fs/promises";
import {
  isOutsideWorkingDirectory,
  resolveFsToolPath,
} from "../tools/fs.js";
import {
  stripSentinelTokens,
  parseToolCall,
  recognizeBareToolJson,
  looksLikeTruncatedToolCall,
  salvageTruncatedWrite,
  salvageTruncatedWriteFromNative,
  type SalvagedWrite,
  countToolFences,
  parseAllToolCalls,
  groupToolCallsForExecution,
  buildTurnHistory,
  collapseRepeatedText,
  textBeforeToolCall,
  formatToolArgs,
  looksLikePentestTask,
  looksLikeBuildTask,
  looksLikeInformationalQuery,
  looksLikeIdleOrSocialPrompt,
  looksLikeActionNarration,
  looksLikeWebActionNarration,
  localHttpProbeIsFailure,
  localHttpProbeIsSuccess,
  buildWorkflowDirective,
  narrowNmapOperationDirective,
  pentestWorkflowDirective,
  pentestNoLocalServerDirective,
  shouldDimToolChatter,
  looksLikePromptLeak,
} from "./tool-call-parser.js";
import {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanModeAllowedShellCommand,
  isPlanModeAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
  isAbortError,
  shouldEnableImageOcr,
  type SessionPolicy,
} from "./session-policy.js";
import {
  saveToolOutput,
  formatToolContext,
} from "./tool-output-formatting.js";
import {
  codingSessionFromContext,
  isProtocolPlaceholderOutput,
} from "./progress-pause-policy.js";
import {
  planContextMessage,
  removePlanContextMessage,
  upsertPlanContextMessage,
  handlePlanTool,
  resolvePlanTaskId,
} from "./plan-tool.js";
import {
  readDeclaredParentTaskId,
  resolveResponderParent,
  isExplicitResponderDelegation,
  delegationTaskTitle,
} from "./responder-parent.js";
import {
  readTaskUpdateArgs,
  distinctAdvancingTaskIds,
  isSimultaneousTaskAdvance,
  batchUpdateSignature,
  buildMultiUpdateReminder,
  buildMultiOpenRejection,
  multiUpdateToast,
  multiOpenToast,
  openingTaskIds,
  type TaskUpdateIntent,
  type BatchTaskDescriptor,
} from "./task-sync.js";
import {
  absorbLooseWorkIntoLedger,
  applyDestinationCwd,
  canMarkTaskDone,
  classifyTaskTitle,
  hasLocalRuntimeProof,
  hasRemoteWorkProof,
  isDevServerCall,
  isEvidenceWorkTool,
  isFeatureImplementationCall,
  isPackageInstallCommand,
  isPlanPreflightTool,
  isPortListeningOutput,
  isReadOnlyReconTool,
  isReadOnlyVersionProbeCommand,
  isRemoteActiveTestCall,
  isRemoteReconToolCall,
  isScaffoldCreateCommand,
  isServerReadyOutput,
  ledgerFromTaskEvidence,
  pickPendingTaskForToolCall,
  recordTaskWorkSuccess,
  resolveUserDestinationHint,
  taskEvidenceFromLedger,
  TOOL_ABORT_GRACE_MS,
  toolHardBudgetMs,
  toolStallBudgetMs,
  type LooseWorkReceipt,
  userAskedForFeatureApp,
  type TaskWorkLedger,
  type TaskWorkSignals,
} from "./task-evidence.js";
import {
  buildSessionStateBlock,
  inferNextHint,
  upsertSessionStateMessage,
  type SessionStateSnapshot,
} from "./session-state.js";
import {
  buildContinueOrientation,
  looksLikeContinueOrResumePrompt,
  type PreviousTurnSignal,
} from "./continue-orient.js";
import { detectPackageManager } from "./workspace-orient.js";
import {
  budgetRemaining,
  consumeBudget,
  createRecoveryBudgets,
} from "./must-continue.js";
import { chooseFinalizeRecovery } from "./finalize-gate.js";
import { outOfScopeToolMessage, scopeContextMessage } from "./scope-context.js";
import {
  EngagementPolicyEngine,
  actionFromUrl,
  engagementActionsForToolCall,
  evaluateEngagementAction,
  type PolicyLease,
} from "../safety/engagement-policy.js";
import { patchPlanMeta } from "../store/plan.js";
import {
  extractProjectRootFromPlan,
  extractProjectRootFromScaffold,
  extractProjectRootFromText,
  getActiveProjectRoot,
  setActiveProjectRootIfValid,
} from "./project-root.js";
import {
  buildWorkspaceOrientation,
  discoverImmediateProjectRoots,
  guessProjectFolderName,
  isBareParentDirectory,
  isScaffoldCancelledOutput,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  resolveScaffoldTargetPath,
} from "./workspace-orient.js";
import {
  stdioConfirmPort,
  stdioSecretRequester,
  restoreInteractiveStdin,
  ensurePentestAuthorization,
  confirmToolExecution,
  type ConfirmPort,
} from "./confirm-port.js";
import { buildRichStopSummary } from "./stop-summary.js";
import { composeAgentSystemPrompt, type AgentPromptSection } from "./prompt-composer.js";
import {
  createGovernorState,
  governProgress,
  type GovernorState,
} from "./evidence-governor.js";
import {
  createTurnState,
  transitionTurn,
  type TurnState,
  type TurnStateSnapshot,
} from "./turn-state.js";
import {
  deriveOutcomeStatus,
  inferOutcomeKind,
  openOutcomeState,
  recordAnswerEvidence,
  recordFailedHypothesis,
  recordToolEvidence,
  completedOperationObservationDigest,
  saveOutcomeState,
  validateCriterionEvidence,
  type OutcomeEnvelope,
} from "./outcomes.js";
import {
  createTurnOutcome,
  normalizeTurnOutcomeInput,
  renderTurnOutcome,
  type LoopGuardStopInfo,
  type TurnOutcomeStatus,
} from "./turn-outcome.js";
import {
  beginEngagementAction,
  finishEngagementAction,
  recordEngagementCheckpoint,
  reconcileEngagementJob,
  openEngagement,
  saveEngagement,
  type EngagementActionRecord,
  type EngagementGraph,
} from "../store/engagement.js";


export * from "./tool-call-parser.js";
export {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
  shouldEnableImageOcr,
  type SessionPolicy,
} from "./session-policy.js";
export { type ConfirmPort } from "./confirm-port.js";

export function styleToolChatter(call: ToolCall, text: string): string {
  return shouldDimToolChatter(call) ? chalk.dim(text) : text;
}


/**
 * A foreground task waits for a responder child only when the plan
 * Declares that dependency. Report titles carry no scheduling meaning: any
 * Dependency-ready foreground work is executed while children keep running, and
 * Their results arrive as addenda.
 *
 * A declared dependency blocks only while the child is genuinely live (running
 * Job or an undelivered/unanalyzed receipt), so an orphaned child can never
 * Stall the turn forever.
 */
export function shouldYieldForDeclaredResponderDependency(
  plan: SessionPlan | undefined,
  runningJobs: readonly BackgroundJob[],
  notifications: readonly ResponderNotification[],
  currentNotificationId?: string | undefined,
): boolean {
  if (!plan) return false;
  const unfinished = plan.tasks.filter(
    (task) =>
      !task.responderOwned &&
      (task.state === "pending" || task.state === "in_progress"),
  );
  if (unfinished.length === 0) return false;

  const childById = new Map(
    plan.tasks.filter((task) => task.responderOwned).map((task) => [task.id, task]),
  );
  const isLive = (child: PlanTask): boolean => {
    if (child.state === "done" || child.state === "skipped" || child.state === "failed") {
      return false;
    }
    const running = runningJobs.some(
      (job) =>
        job.responder &&
        (job.taskId === child.id || (!!child.jobId && job.id === child.jobId)),
    );
    if (running) return true;
    return notifications.some(
      (notification) =>
        notification.responder &&
        !notification.archivedAt &&
        !notification.readAt &&
        !notification.analyzedAt &&
        (!currentNotificationId || notification.id !== currentNotificationId) &&
        (notification.taskId === child.id ||
          (!!child.jobId && notification.jobId === child.jobId)),
    );
  };

  return unfinished.every((task) =>
    (task.dependencies ?? []).some((dependency) => {
      const child = childById.get(dependency);
      return !!child && isLive(child);
    }),
  );
}
export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
  visionProven?: boolean | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
  onEvent?: ((event: AgentEvent) => void) | undefined;
  /**
   * Called when a turn ends with the FULL conversation for the turn — the user
   * message, every assistant tool-call, every tool result, and the final
   * answer (system prompts excluded). Callers persist this so a resumed
   * session gives the model back what it actually did (commands, outputs,
   * results), not just its prose answers.
   */
  onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  onOutcome?: ((outcome: import("./turn-outcome.js").TurnOutcome) => void) | undefined;
  confirm?: ConfirmPort | undefined;
  requestSecret?:
  | ((request: {
    title: string;
    prompt: string;
  }) => Promise<string | undefined>)
  | undefined;
  session?: SessionPolicy | undefined;
  /** REPL mode: agent executes; plan is planning-only. */
  mode?: Mode | undefined;
  /**
   * Transcript YOU bubble. `null` hides implement/revision choreography from
   * chat; model still receives `prompt`. Omit to show `prompt`.
   */
  displayPrompt?: string | null | undefined;
  /** How the previous turn ended, so recovery is decided from state. */
  previousTurn?: PreviousTurnSignal | undefined;
  /** User-declared model window for this provider/model/session. */
  contextLimitTokens?: number | undefined;
  getContextLimitTokens?: (
    provider: ProviderId | undefined,
    model: string | undefined,
  ) => number | undefined;
}

/**
 * Cancellable backoff. Resolves after `ms`, or rejects immediately if the
 * signal aborts (double-Esc) so recovery waits never trap a cancelled turn.
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runAgentTurn(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<import("./turn-outcome.js").TurnOutcome> {
  const agentMode: Mode =
    options.mode === "plan" || options.mode === "agent" || options.mode === "ask"
      ? options.mode
      : "agent";
  const isPlanMode = agentMode === "plan";
  const writesDirectly = !options.onEvent;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);
  // Whether the CURRENT model iteration has already committed its visible
  // prose to the transcript with an `assistant-message` event. The recovery
  // paths preserve streamed prose before retrying (so it isn't wiped by the
  // next tool-call/turn event); this flag stops them from re-committing prose
  // the normal tool path already surfaced, which would render it twice. Reset
  // at the top of every loop iteration.
  let visibleCommitted = false;
  let interruptedVisible = "";
  let interruptedReasoning = "";
  let lowYieldResumptions = 0;
  const trimExactContinuationOverlap = (
    previous: string,
    current: string,
    minLength = 32,
  ): string => {
    if (previous.length > 0 && current.startsWith(previous)) {
      return current.slice(previous.length);
    }
    const maxLength = Math.min(previous.length, current.length);
    if (maxLength < minLength) return current;
    const pattern = current.slice(0, maxLength);
    const fallback = new Uint32Array(maxLength);
    for (let index = 1, matched = 0; index < maxLength; index += 1) {
      while (matched > 0 && pattern[index] !== pattern[matched]) {
        matched = fallback[matched - 1]!;
      }
      if (pattern[index] === pattern[matched]) matched += 1;
      fallback[index] = matched;
    }
    let matched = 0;
    for (
      let index = previous.length - maxLength;
      index < previous.length;
      index += 1
    ) {
      while (matched > 0 && previous[index] !== pattern[matched]) {
        matched = fallback[matched - 1]!;
      }
      if (previous[index] === pattern[matched]) matched += 1;
      if (matched === maxLength && index < previous.length - 1) {
        matched = fallback[matched - 1]!;
      }
    }
    return matched >= minLength ? current.slice(matched) : current;
  };
  const writeStatus = (text: string): void => {
    // Footer activity is single-line; collapse newlines and indents.
    // Never surface /output path hints as activity (garbles the status bar).
    let cleaned = text.replace(/\s+/g, " ").trim();
    if (
      /\/output\b|open full output|Ctrl\+O or|\.clai\/outputs/i.test(cleaned)
    ) {
      return;
    }
    // API key rotation / retry lines need more room than tool-name chips.
    const keyLine =
      /^(using |switching |⏳ |all .+ API keys)/i.test(cleaned);
    const maxLen = keyLine ? 96 : 64;
    if (cleaned.length > maxLen) {
      if (keyLine) {
        cleaned = cleaned.slice(0, maxLen - 1) + "…";
      } else {
        const short = cleaned.match(/^[\w./-]+/);
        cleaned = short ? short[0]! : cleaned.slice(0, maxLen - 3) + "…";
      }
    }
    emit({ type: "status", text: cleaned || "working" });
  };
  const writeNotice = (level: "info" | "warn", text: string): void => {
    emit({ type: "notice", level, text });
  };
  const writeAssistantMessage = (text: string): void => {
    // Never surface an empty message: the reducer drops it and a consumer
    // would paint a stray blank row.
    const clean = sanitizeAssistantText(text);
    if (!clean.trim()) return;
    visibleCommitted = true;
    emit({ type: "assistant-message", text: clean });
  };
  const writeThinkingBlock = (content: string): void => {
    emit({ type: "thinking-block", content });
  };
  const writeToolOutput = (
    id: string,
    chunk: string,
    options?: { replace?: boolean },
  ): void => {
    emit({
      type: "tool-output",
      id,
      chunk,
      ...(options?.replace ? { replace: true } : {}),
    });
  };
  const writeToolCall = (
    id: string,
    call: ToolCall,
    rendered: string,
  ): void => {
    emit({
      type: "tool-call",
      id,
      name: call.name,
      argsDisplay: formatToolArgs(call),
    });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writePlanUpdate = (plan: SessionPlan): void => {
    emit({ type: "plan-update", plan });
  };
  const writeToolBlocked = (id: string, name: string, reason: string): void => {
    emit({ type: "tool-blocked", id, name, reason });
  };
  const writeAbort = (): void => {
    emit({ type: "turn-aborted" });
  };
  const emitToolResult = (
    id: string,
    result: ToolResult,
    summary: string,
    artifactPath?: string,
  ): void => {
    const event: Extract<AgentEvent, { type: "tool-result" }> = {
      type: "tool-result",
      id,
      ok: result.ok,
      summary,
    };
    if (typeof result.exitCode === "number") {
      event.exitCode = result.exitCode;
    }
    if (artifactPath) {
      event.artifactPath = artifactPath;
    }
    if (result.fileChanges && result.fileChanges.length > 0) {
      event.fileChanges = result.fileChanges;
    }
    emit(event);
  };
  /** Strip a known prefix from a string, returning the remainder unchanged. */
  const insertedText = (value: string, prefix: string): string =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;
  const writeCompactionStarted = (
    id: string,
    beforeTokens: number,
  ): void => {
    emit({ type: "compaction-start", id, beforeTokens });
  };
  const writeCompactionDelta = (
    id: string,
    text: string,
    replace = false,
  ): void => {
    if (!text && !replace) return;
    emit({
      type: "compaction-delta",
      id,
      text,
      ...(replace ? { replace: true } : {}),
    });
  };
  const writeCompactionCompleted = (
    id: string,
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ): void => {
    emit({
      type: "compaction-completed",
      id,
      summary,
      beforeTokens,
      afterTokens,
    });
  };
  const writeCompactionFailed = (
    id: string,
    message: string,
    retainedTokens: number,
  ): void => {
    emit({ type: "compaction-failed", id, message, retainedTokens });
  };
  // Points at the live message array so finishTurn can hand the full
  // conversation back to the caller. Assigned once `messages` is built below;
  // all later mutations are in-place so this reference stays current.
  let liveMessages: ChatMessage[] = [];
  let suppressOutcomeDiagnostics = false;
  const unreadResponderNotificationIds = new Set<string>();
  const releaseUnreadResponderClaims = (): void => {
    // No session filter: this helper runs in the outer turn scope, before the
    // session policy exists, and every id here is already known to belong to
    // this turn (notification ids are globally unique).
    const pending = new Map(
      jobManager
        .getPendingNotifications()
        .map((notification) => [notification.id, notification]),
    );
    for (const notificationId of unreadResponderNotificationIds) {
      const notification = pending.get(notificationId);
      if (
        notification?.deliveryStartedAt &&
        !notification.readAt &&
        !notification.analyzedAt &&
        !notification.acknowledgedAt
      ) {
        continue;
      }
      jobManager.releaseResponderNotificationClaim(notificationId);
    }
  };
  const finishTurn = (
    answer: string,
    steps: number,
    status: TurnOutcomeStatus = "succeeded",
    remainingCriteria: readonly string[] = [],
    reason?: string,
    displayAnswer?: string,
    loopGuardStop?: LoopGuardStopInfo,
  ): import("./turn-outcome.js").TurnOutcome => {
    releaseUnreadResponderClaims();
    const outcome = createTurnOutcome(
      normalizeTurnOutcomeInput({
        status,
        answer,
        steps,
        remainingCriteria,
        reason,
        ...(loopGuardStop ? { loopGuardStop } : {}),
      }),
    );
    const renderOptions = {
      diagnostics: !suppressOutcomeDiagnostics,
    };
    const rendered = renderTurnOutcome(outcome, renderOptions);
    const displayRendered =
      displayAnswer === undefined
        ? rendered
        : renderTurnOutcome({ ...outcome, answer: displayAnswer }, renderOptions);
    if (displayRendered.trim()) {
      writeAssistantMessage(displayRendered);
    } else {
      emit({ type: "assistant-message", text: "" });
    }
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, displayRendered));
      } catch {
        // Persisting history must never break the turn.
      }
    }
    options.onOutcome?.(outcome);
    emit({ type: "turn-end", outcome, finalAnswer: rendered, steps });
    return outcome;
  };

  try {
    emit({
      type: "turn-start",
      prompt,
      ...(options.displayPrompt !== undefined
        ? { displayPrompt: options.displayPrompt }
        : {}),
    });
    const config = getConfig();
    const maxSteps = options.maxSteps ?? 70;
    const confirmPort = options.confirm ?? stdioConfirmPort;
    const projectContext = await loadProjectContext();
    const hasAttachedImages = Boolean(options.images?.length);
    const imageOcrEnabled = shouldEnableImageOcr(
      prompt,
      hasAttachedImages,
      options.visionProven !== false,
    );
    const initialProvider = options.provider ?? config.defaultProvider;
    const initialModel = options.model ?? getProviderModel(initialProvider);
    // image.view is different from optimistic user-attachment handling: once
    // the tool succeeds, the model must actually receive and inspect its bytes.
    // Offer it only with affirmative capability evidence for the active route.
    const routeToolNames = (routeProvider: ProviderId, routeModel: string): string[] =>
      availableToolNames().filter((name) => {
        if (name === "image.ocr") return imageOcrEnabled;
        if (name === "image.view") {
          return modelSupportsVision(routeProvider, routeModel);
        }
        return true;
      });
    const toolNames = routeToolNames(initialProvider, initialModel);
    // Build / scaffold / continuation turns must NEVER be diverted into a
    // web.search for "current info". The /implement directive ("Execute it
    // now…") and prompts like "create a react app" contain words such as
    // "now"/"latest" that trip the volatile-info regex; without this guard the
    // agent burns its turn searching the date instead of writing files.
    const buildLikeTurn = looksLikeBuildTask(prompt, options.history);
    const pentestLikeTurn = looksLikePentestTask(prompt, options.history);
    const narrowNmapOperation = isNarrowExplicitNmapOperation(prompt);
    // A plain informational follow-up ("what do you know so far", "summarize
    // the findings") in a resumed/continuing build or pentest session must
    // NOT inherit that session's "must act" behavior — it should be answered
    // from context, not treated as a signal to start executing or to invent a
    // brand-new plan (the exact failure where "what do u know till now"
    // triggered explore→plan and created an unrelated "Enhance clai" plan).
    const informationalQuery = looksLikeInformationalQuery(prompt);
    // Greetings / thanks / short acks must never force tools or plans.
    const idleOrSocialPrompt = looksLikeIdleOrSocialPrompt(prompt);
    suppressOutcomeDiagnostics =
      informationalQuery ||
      idleOrSocialPrompt ||
      looksLikeContinueOrResumePrompt(prompt);
    let provider = initialProvider;
    await ensureProviderConfigured(provider);
    let model = initialModel;
    const currentContextLimitTokens = (): number | undefined =>
      options.getContextLimitTokens
        ? options.getContextLimitTokens(provider, model)
        : options.contextLimitTokens;
    // Some Groq free-tier models have a per-request/per-minute input budget
    // below the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget =
      provider === "groq" ? groqInputTokenBudget(model) : undefined;
    const useCompactSystemPrompt = inputTokenBudget !== undefined;
    const resolveNativeTools = (
      p: ProviderId,
      m: string,
    ): { dialect: ReturnType<typeof resolveToolDialect>; native: boolean } => {
      const dialect = resolveToolDialect(p, m, config.toolCalling);
      return { dialect, native: dialect !== "none" };
    };
    let { dialect: toolDialect, native: nativeToolsActive } = resolveNativeTools(
      provider,
      model,
    );
    const selectToolDefs = (
      native: boolean,
      compact: boolean,
      routeProvider: ProviderId = provider,
      routeModel: string = model,
    ): ToolDefinition[] | undefined => {
      if (!native) return undefined;
      const base = compact
        ? getCompactToolDefinitions()
        : getToolDefinitions();
      const allow = new Set([
        ...routeToolNames(routeProvider, routeModel),
        ...RUNNER_META_TOOL_NAMES,
      ]);
      return base.filter((d) => allow.has(d.name));
    };
    let lastAnswer = "";
    const session: SessionPolicy = options.session ?? createSessionPolicy();
    // Defensive init: external/legacy callers may build a policy without the
    // newer sync-guard holders. Never dereference an undefined holder.
    if (!session.pendingTaskBatch) session.pendingTaskBatch = { value: undefined };
    if (!session.pendingDependency) session.pendingDependency = { value: undefined };
    // One-shot CLI / tests that never entered TUI/REPL still need an isolated
    // scratch+output workspace. No-op when a session already bound one.
    if (!getActiveSessionWorkspace()) {
      beginSessionWorkspace();
    }

    // Active plan context
    // If this session already has a plan, inject it so the model keeps it in
    // context. When the user has approved it (via /implement) we instruct the
    // agent to execute task by task; otherwise the agent should refine/wait.
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    if (activePlan && isPlanApprovedByStatus(activePlan.status)) {
      // session.planApproved is in-memory only (never persisted), so a
      // resumed session (via /history) or a fresh SessionPolicy after
      // context compaction always starts it back at false — even when the
      // plan's OWN durable status shows it was already approved/executed/
      // completed via /implement. Re-derive the flag from the plan's status
      // on every load so resuming a session never re-blocks tool calls
      // behind a stale "awaiting approval" gate for a plan that already ran.
      session.planApproved.value = true;
    }
    suppressOutcomeDiagnostics ||= !session.planApproved.value;

    const destinationHint = resolveUserDestinationHint(prompt);
    const orientationSourceText = [
      prompt,
      activePlan?.goal,
      activePlan?.detail,
      activePlan?.tasks.map((task) => task.title).join(" "),
    ].filter(Boolean).join("\n");
    const fromPlan = extractProjectRootFromPlan(activePlan);
    const fromPrompt = extractProjectRootFromText(prompt);
    const guessedName = guessProjectFolderName(orientationSourceText);
    const orientationParent =
      destinationHint ?? (isBareParentDirectory(safeCwd()) ? safeCwd() : undefined);
    const guessedProject =
      orientationParent && guessedName ? join(orientationParent, guessedName) : undefined;
    const discoveredProjects = orientationParent
      ? discoverImmediateProjectRoots(orientationParent)
      : [];

    // Sticky project root so relative fs paths never hit the agent package.
    // Preference is explicit durable plan metadata, explicit prompt paths,
    // exact natural-language folder guesses, then one unambiguous discovered
    // project. Never pin bare Desktop/home or invent a path before it exists.
    let pinnedProject = false;
    for (const candidate of [fromPlan, fromPrompt, guessedProject]) {
      if (setActiveProjectRootIfValid(candidate)) {
        pinnedProject = true;
        break;
      }
    }
    if (!pinnedProject && discoveredProjects.length === 1) {
      setActiveProjectRootIfValid(discoveredProjects[0]);
    }
    // Only long-lived instructions belong in the provider-cached system prefix.
    // Request, project, workspace, recovery, scope, and plan state are appended
    // later as system-marked turns so a changing byte cannot invalidate the
    // constitution (and, on Anthropic, the native tool schemas before it).
    // The red-team methodology block is ~940 tokens on every request. Attach it
    // only when this turn is actually a remote-security engagement.
    const pentestPromptTurn =
      pentestLikeTurn || activePlan?.kind === "pentest";
    const buildStableSystemContent = (native: boolean): string => {
      const reliability = getReliabilityPolicy();
      const visionAvailable = modelSupportsVision(provider, model);
      return (useCompactSystemPrompt
        ? renderCompactAgentSystemPrompt
        : renderAgentSystemPrompt)(routeToolNames(provider, model).join(", "), {
          nativeTools: native,
          stableEnvironment: true,
          imageView: visionAvailable,
          // E6: slim native constitution when API tool schemas are attached.
          ...(native ? { slimNative: reliability.slimNativePrompt } : {}),
        });
    };
    const systemSections: string[] = [
      renderRequestEnvironmentContext({ plan: activePlan }),
    ];
    if (projectContext) {
      systemSections.push(
        `Project context from .clai/context.md:\n${projectContext}`,
      );
    }
    const projectRoot = getActiveProjectRoot();
    if (projectRoot) {
      systemSections.push(
        `ACTIVE PROJECT ROOT: ${projectRoot}\n` +
        `All relative paths (./src/…, manifests, configs) resolve under this directory — NOT the agent process cwd. ` +
        `Prefer absolute paths under this root. shell cwd for install / run / build must be this root ` +
        `(or its parent when creating a NEW named subfolder with a scaffolder). ` +
        `Never write user app source into the agent package tree.`,
      );
    } else if (destinationHint) {
      systemSections.push(
        `USER DESTINATION: create or continue work under "${destinationHint}" (parent folder). ` +
        `Pick or detect a project subfolder; do not scaffold into the agent working tree unless the user asked for that.`,
      );
    }
    // Stack-agnostic PWD / existing-project snapshot so weak models cannot
    // skip explore and re-scaffold into non-empty dirs. This is live filesystem
    // data and therefore must remain outside the cached constitution.
    if (
      buildLikeTurn &&
      !informationalQuery &&
      !idleOrSocialPrompt
    ) {
      const guessedName = guessProjectFolderName(
        [prompt, activePlan?.goal, activePlan?.detail, activePlan?.tasks.map((t) => t.title).join(" ")]
          .filter(Boolean)
          .join("\n"),
      );
      const extraPaths: string[] = [];
      if (destinationHint && guessedName) {
        extraPaths.push(join(destinationHint, guessedName));
      }
      const fromText =
        extractProjectRootFromPlan(activePlan) ??
        extractProjectRootFromText(prompt);
      if (fromText) extraPaths.push(fromText);
      const orientInput: {
        cwd: string;
        destinationHint?: string;
        candidateProject?: string;
        extraPaths: string[];
      } = {
        cwd: safeCwd(),
        extraPaths,
      };
      if (destinationHint) orientInput.destinationHint = destinationHint;
      const candidate = getActiveProjectRoot() ?? fromText;
      if (candidate) orientInput.candidateProject = candidate;
      systemSections.push(buildWorkspaceOrientation(orientInput));
    }
    // The live plan is mutable state: it is injected once as a keyed request
    // suffix (upsertPlanContextMessage) instead of being frozen into the stable
    // system prefix, so the model never sees a stale and a fresh plan together.

    // Soft mid-work recovery (any domain): re-attach to jobs / open tasks /
    // last tools after interrupt or "continue" — not a hard gate.
    if (!informationalQuery && !idleOrSocialPrompt) {
      const continueBrief = buildContinueOrientation({
        prompt,
        history: options.history,
        plan: activePlan,
        runningJobs: jobManager.getRunningJobs(session.sessionId),
        recentJobs: jobManager.getRecentJobs(12, session.sessionId),
        informationalQuery,
        idleOrSocial: idleOrSocialPrompt,
        ...(options.previousTurn ? { previousTurn: options.previousTurn } : {}),
      });
      if (continueBrief) {
        systemSections.push(continueBrief);
      }
    }

    if (isPlanMode) {
      systemSections.push(planModeDirective());
    } else if (agentMode === "agent") {
      systemSections.push(agentModeDirective());
    }

    // Build focus card: orientation + feature quality, not forced plan theater.
    if (
      buildLikeTurn &&
      !informationalQuery &&
      !idleOrSocialPrompt &&
      !isPlanMode
    ) {
      systemSections.push(buildWorkflowDirective());
    }
    if (
      isPlanMode &&
      buildLikeTurn &&
      !informationalQuery &&
      !idleOrSocialPrompt
    ) {
      systemSections.push(buildWorkflowDirective());
    }

    // A bounded explicit nmap request is one operation, not an invitation to
    // manufacture a full engagement plan or add unrelated recon steps.
    if (
      narrowNmapOperation &&
      !informationalQuery &&
      !idleOrSocialPrompt &&
      !isPlanMode
    ) {
      systemSections.push(narrowNmapOperationDirective());
    }

    // Broader pentest / security engagements need a different shape than a coding
    // build: recon first, then a plan built from real findings, then
    // incremental task additions as new attack surface appears.
    if (
      pentestLikeTurn &&
      !narrowNmapOperation &&
      !activePlan &&
      !informationalQuery &&
      !idleOrSocialPrompt
    ) {
      systemSections.push(pentestWorkflowDirective());
    }

    // Any remote/security engagement (even with an existing or completed plan)
    // must never fall into the coding "start localhost dev server" habit.
    const pentestSession =
      pentestLikeTurn ||
      activePlan?.kind === "pentest" ||
      (activePlan?.kind !== "coding" &&
        Boolean(
          activePlan?.goal &&
          /pentest|vulnerab|recon|security assess|attack surface|red team/i.test(
            activePlan.goal,
          ),
        ));
    if (pentestSession && !idleOrSocialPrompt) {
      systemSections.push(pentestNoLocalServerDirective());
    }

    {
      const engScope = await loadScope().catch(() => undefined);
      const scopeBlock = scopeContextMessage(engScope);
      if (scopeBlock && (pentestSession || pentestLikeTurn) && !idleOrSocialPrompt) {
        systemSections.push(scopeBlock);
      }
    }

    // Soft task analysis for multi-step work (never a forced plan script).
    {
      const earlyAnalysis = analyzeTask(prompt);
      if (
        !idleOrSocialPrompt &&
        !informationalQuery &&
        !narrowNmapOperation &&
        (earlyAnalysis.shouldPlan ||
          earlyAnalysis.complexity === "complex" ||
          buildLikeTurn ||
          pentestLikeTurn)
      ) {
        systemSections.push(formatTaskAnalysisHint(earlyAnalysis));
      }
    }

    const promptSections = (): AgentPromptSection[] => {
      const sections: AgentPromptSection[] = systemSections.map((content) => ({
        kind: content.startsWith("ACTIVE PLAN")
          ? "plan"
          : content.startsWith("ENGAGEMENT SCOPE")
            ? "scope"
            : content.includes("MODE")
              ? "mode"
              : content.includes("OUTCOME")
                ? "outcome"
                : content.includes("WORKFLOW") || content.includes("FOCUS")
                  ? "focus"
                  : "context",
        content,
        mandatory:
          content.startsWith("ACTIVE PLAN") ||
          content.startsWith("ENGAGEMENT SCOPE") ||
          content.startsWith("REQUEST ENVIRONMENT") ||
          content.startsWith("Project context from .clai/context.md:") ||
          content.startsWith("ACTIVE PROJECT ROOT:") ||
          content.startsWith("USER DESTINATION:") ||
          content.startsWith("WORKSPACE STATUS") ||
          content.includes("MODE") ||
          content.includes("OUTCOME"),
      }));
      const has = (kind: AgentPromptSection["kind"]): boolean =>
        sections.some((section) => section.kind === kind);
      if (!has("outcome")) {
        sections.push({
          kind: "outcome",
          content: `OUTCOME CONTRACT\nGoal: ${prompt}\nSuccess requires evidence that the requested result is complete; otherwise return partial, blocked, failed, aborted, or paused_budget with remaining criteria.`,
          mandatory: true,
        });
      }
      if (!has("plan")) {
        sections.push({
          kind: "plan",
          content:
            "PLAN PROTOCOL\nThe live plan, when one exists, is appended to this request as a single ACTIVE PLAN message. Treat that message as the only authoritative plan state; never rely on plan details quoted in earlier turns.",
          mandatory: true,
        });
      }
      if (!has("scope")) {
        sections.push({
          kind: "scope",
          content: "ENGAGEMENT SCOPE\nNo active remote-security scope applies to this turn.",
          mandatory: true,
        });
      }
      sections.push({
        kind: "context",
        content: `TASK STATE\nMode: ${agentMode}. Current request: ${prompt}`,
        mandatory: true,
      });
      return sections;
    };
    const composeCurrentSystemPrompt = (native: boolean): string =>
      buildStableSystemContent(native);
    const requestContext = composeAgentSystemPrompt({
      mode: agentMode,
      nativeToolsActive,
      maxTokens: inputTokenBudget
        ? Math.min(2_000, Math.floor(inputTokenBudget * 0.4))
        : undefined,
      sections: promptSections(),
    }).content;
    const fullSystemPrompt = composeCurrentSystemPrompt(nativeToolsActive);
    // Backend-only directives (implement, displayPrompt=null) stay in model
    // history but must never become a YOU bubble on live or /history hydrate.
    const hideUserBubble =
      options.displayPrompt === null || options.displayPrompt === "";
    const userMessage: ChatMessage = {
      role: "user",
      content: prompt,
      ...(hideUserBubble ? { internal: true } : {}),
    };
    if (options.images && options.images.length > 0) {
      userMessage.images = options.images;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...(options.history ?? []),
      // Keep all per-request authority after prior history. This preserves the
      // longest shared prefix for APC providers while single-system dialects
      // retain it in place as a marked user turn.
      { role: "system", content: `REQUEST CONTEXT\n${requestContext}` },
      userMessage,
    ];
    liveMessages = messages;
    if (activePlan) {
      upsertPlanContextMessage(
        messages,
        planContextMessage(activePlan, session.planApproved.value),
      );
    }
    const responderWakeTurn =
      options.displayPrompt === null &&
      prompt.startsWith("Responder result arrived");
    const responderWakeNotificationId = responderWakeTurn
      ? /^notification=(.+)$/m.exec(prompt)?.[1]?.trim()
      : undefined;
    const responderWakeJobId = responderWakeTurn
      ? /^job=(.+)$/m.exec(prompt)?.[1]?.trim()
      : undefined;
    const responderWakeResultRevision = responderWakeTurn
      ? Number(/^resultRevision=(\d+)$/m.exec(prompt)?.[1]) || undefined
      : undefined;
    const matchesWakeRevision = (notification: ResponderNotification): boolean =>
      responderWakeResultRevision === undefined ||
      (notification.resultRevision ?? 1) === responderWakeResultRevision;
    const wakeNotification = responderWakeNotificationId
      ? jobManager
          .getPendingNotifications(session.sessionId)
          .find(
            (notification) =>
              notification.id === responderWakeNotificationId &&
              (!responderWakeJobId || notification.jobId === responderWakeJobId) &&
              matchesWakeRevision(notification),
          )
      : undefined;
    if (wakeNotification) {
      unreadResponderNotificationIds.add(wakeNotification.id);
    }
    const refreshResponderInbox = (): ResponderNotification | undefined => {
      const running = jobManager
        .getRunningJobs(session.sessionId)
        .filter((job) => job.responder);
      if (responderWakeTurn) {
        const pending = jobManager
          .getPendingNotifications(session.sessionId)
          .filter(
            (notification) =>
              notification.responder &&
              unreadResponderNotificationIds.has(notification.id) &&
              matchesWakeRevision(notification) &&
              !notification.readAt &&
              !notification.analyzedAt &&
              !notification.archivedAt,
          )
          .slice(0, 1);
        upsertResponderContextMessage(
          messages,
          responderContextMessage({ running, pending }),
        );
        return undefined;
      }
      const leaseId = jobManager.getResponderLeaseId(session.sessionId);
      const delivery = leaseId
        ? jobManager.claimNextResponderNotification(session.sessionId, leaseId)
        : undefined;
      if (delivery) unreadResponderNotificationIds.add(delivery.id);
      const pending = jobManager
        .getPendingNotifications(session.sessionId)
        .filter(
          (notification) =>
            notification.responder &&
            unreadResponderNotificationIds.has(notification.id) &&
            !notification.readAt &&
            !notification.analyzedAt &&
            !notification.archivedAt,
        )
        .slice(0, 12);
      upsertResponderContextMessage(
        messages,
        responderContextMessage({ running, pending }),
      );
      return delivery;
    };
    /** Assigned after session flags exist — see below. */
    let refreshSessionState: (
      plan?: SessionPlan | null | undefined,
    ) => void = () => undefined;
    /** Model-only nudge — never shown as a YOU bubble / WARN in the chat UI. */
    const recoveryUserMessage = (content: string): ChatMessage => {
      const message: ChatMessage = { role: "user", content, internal: true };
      if (options.images && options.images.length > 0) {
        // Some OpenAI-compatible gateways/models attend most strongly to the
        // latest user turn. Keep the image attached on recovery nudges so a
        // thinking-only retry does not degrade into OCR/tool guessing.
        message.images = options.images;
      }
      return message;
    };

    const upsertActionCycleRecovery = (content: string): void => {
      const prefix = "[ACTION CYCLE RECOVERY] ";
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === "user" && message.internal && message.content.startsWith(prefix)) {
          messages.splice(index, 1);
          break;
        }
      }
      messages.push(recoveryUserMessage(prefix + content));
    };

    const recoveryProse = (content: string): string | undefined => {
      const text = textBeforeToolCall(stripSentinelTokens(content)).trim();
      if (
        !text ||
        /^```|^\{|<tool_call>|<\|tool_call(?:s_section)?_begin\|>/i.test(
          text,
        ) ||
        /\n\s*\{[\s\S]*\}\s*$/.test(text)
      ) {
        return undefined;
      }
      return text;
    };
    const pushAssistantHistory = (content: string): void => {
      const cleaned = sanitizeAssistantText(
        hasReasoningMarker(content) ? stripThinking(content).visible : content,
      );
      if (!visibleCommitted) {
        const prose = recoveryProse(cleaned);
        if (prose) writeAssistantMessage(prose);
      }
      messages.push({
        role: "assistant",
        content: cleaned.trim()
          ? cleaned
          : "[No visible assistant response was produced.]",
      });
    };


    const loopGuard = new LoopGuard();
    let lastExactPromptTokens = 0;
    let consecutiveSynthesizedRounds = 0;
    const engagementPolicy = new EngagementPolicyEngine();
    const probeStateKey = (call: ToolCall): string | undefined => {
      const project = (job: ReturnType<typeof jobManager.getJob>) =>
        job
          ? [
              job.id,
              job.status,
              job.exitCode ?? null,
              job.signal ?? null,
              job.stdoutArtifact,
              job.artifacts.stdout.bytes,
              job.artifacts.stdout.sha256,
              job.stderrArtifact,
              job.artifacts.stderr.bytes,
              job.artifacts.stderr.sha256,
            ]
          : undefined;
      if (call.name === "shell.tail" && typeof call.args.id === "string") {
        const projected = project(jobManager.getJob(call.args.id));
        return projected ? JSON.stringify(projected) : undefined;
      }
      if (call.name === "shell.jobs") {
        return JSON.stringify(
          jobManager
            .getRecentJobs(100, session.sessionId)
            .map((job) => project(job))
            .filter(Boolean),
        );
      }
      return undefined;
    };

    // Track consecutive thinking-only responses so we can nudge the model
    // to actually act instead of silently returning an empty answer.
    let emptyVisibleRetries = 0;
    let truncatedBudgetRounds = 0;

    let retryWithoutThinking = false;

    // Robust stream-failure recovery. When a provider stream/complete fails we
    // try working approaches (backoff, compaction, thinking-off, provider
    // fallback) before surrendering the turn — see ./stream-recovery. Both are
    // reset on any successful stream so each failure episode gets a fresh
    // budget and we only give up in the worst case.
    let allowModelFallback = false;
    let preferModelFallback = false;
    const recoveryState = createStreamRecoveryState();

    // Track tool calls truncated by the token limit so we can ask the model
    // to retry in smaller pieces instead of leaking broken JSON as an answer.
    let truncatedToolRetries = 0;

    /** Consecutive model rounds whose native tool arguments were unusable. */
    let malformedNativeArgsRounds = 0;


    let bareToolJsonRetries = 0;

    // Track a ```tool fence that is present but whose JSON could not be parsed
    // (e.g. malformed extra/missing braces that are NOT simple truncation). We
    // retry instead of leaking the raw block as the final answer.
    let malformedFenceRetries = 0;


    const recovery = createRecoveryBudgets();
    let sawServerStart = false;
    let sawPlanCreateOk = false;
    let sawServerTail = false;
    let sawLocalHttpProbe = false;
    let sawFailedLocalHttpProbe = false;
    let sawLocalAppMaterialWork = false;
    let sawScaffoldOk = false;
    let sawFeatureImplWrite = false;
    let sawActivePentestTest = false;
    const featureAppAsk = userAskedForFeatureApp(prompt);
    let taskWorkLedger: TaskWorkLedger | null = null;
    /**
     * Successful real tools this turn that may not yet be credited to a task
     * (preflight tool.check before in_progress, or work before plan existed).
     * Absorbed into the task ledger when opening or marking done.
     */
    const sessionLooseWork: LooseWorkReceipt[] = [];

    const planHasVerifiedRuntime = (plan: SessionPlan): boolean =>
      plan.tasks.some((task) => hasLocalRuntimeProof(task.evidence));

    const planHasVerifiedRemoteWork = (plan: SessionPlan): boolean =>
      plan.tasks.some((task) => hasRemoteWorkProof(task.evidence));

    /** Rehydrate turn-local runtime/remote flags from durable plan evidence (resume). */
    const rehydrateSessionFlagsFromPlan = (plan: SessionPlan | undefined): void => {
      if (!plan) return;
      for (const task of plan.tasks) {
        const e = task.evidence;
        if (!e) continue;
        if (e.sawDevServerStart || e.sawServerReady || e.sawPortListening) {
          sawServerStart = true;
        }
        if (e.sawServerReady || e.sawDevServerStart) sawServerTail = true;
        if (e.sawLocalHttpProbeOk) sawLocalHttpProbe = true;
        if (e.sawRemoteActiveTestOk) sawActivePentestTest = true;
      }
    };
    rehydrateSessionFlagsFromPlan(activePlan);

    /** Merge loose turn work + live ledger for a task before evidence gates. */
    const ledgerForTaskGate = (
      plan: SessionPlan,
      taskId: string,
    ): TaskWorkLedger | null => {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      const durableLedger = ledgerFromTaskEvidence(taskId, task?.evidence);
      let ledger: TaskWorkLedger | null =
        taskWorkLedger?.taskId === taskId &&
        taskWorkLedger.successWorkCount >= durableLedger.successWorkCount
          ? taskWorkLedger
          : durableLedger;
      ledger = absorbLooseWorkIntoLedger(
        ledger,
        taskId,
        task?.title ?? "",
        sessionLooseWork,
        { planKind: plan.kind },
      );
      // Keep the live ledger in sync so subsequent tools append correctly.
      if (ledger && ledger.successWorkCount > 0) {
        if (
          !taskWorkLedger ||
          taskWorkLedger.taskId !== taskId ||
          taskWorkLedger.successWorkCount < ledger.successWorkCount
        ) {
          taskWorkLedger = ledger;
        }
      }
      return ledger;
    };

    const completionGateForTask = (
      plan: SessionPlan,
      taskId: string,
    ): ReturnType<typeof canMarkTaskDone> => {
      const task = plan.tasks.find((candidate) => candidate.id === taskId);
      const ledger = ledgerForTaskGate(plan, taskId);
      return canMarkTaskDone(ledger, taskId, {
        taskTitle: task?.title,
        featureAppRequired: featureAppAsk,
        existingProject: scaffoldLooksMaterialized(getActiveProjectRoot()),
        runtimeVerified: planHasVerifiedRuntime(plan),
        planKind: plan.kind,
        remoteWorkVerified: planHasVerifiedRemoteWork(plan),
      });
    };

    async function persistProjectRootOnPlan(root: string): Promise<void> {
      const pm = detectPackageManager(root);
      // Metadata patches go through the transactional boundary so a
      // concurrent task transition or responder settlement is not clobbered.
      await mutatePlan(session.sessionId, (draft) => {
        patchPlanMeta(draft, {
          projectRoot: root,
          ...(pm ? { packageManager: pm } : {}),
        });
      }).catch(() => undefined);
    }

    /** Persist task evidence without rewriting the whole plan. */
    async function persistTaskEvidence(
      taskId: string,
      evidence: TaskEvidence,
    ): Promise<void> {
      await mutatePlan(session.sessionId, (draft) => {
        const task = draft.tasks.find((candidate) => candidate.id === taskId);
        if (!task) return false;
        task.evidence = evidence;
      }).catch(() => undefined);
    }

    refreshSessionState = (plan?: SessionPlan | null | undefined): void => {
      if (idleOrSocialPrompt || informationalQuery) return;
      const runningJobs = jobManager.getRunningJobs(session.sessionId);
      const p = plan === null ? undefined : plan ?? activePlan;
      if (
        !buildLikeTurn &&
        !pentestLikeTurn &&
        !p &&
        runningJobs.length === 0
      ) {
        if (plan === null) removePlanContextMessage(messages);
        return;
      }
      const root = getActiveProjectRoot() ?? p?.meta?.projectRoot;
      const pm =
        p?.meta?.packageManager ??
        (root ? detectPackageManager(root) : undefined);
      const open = p?.tasks.find(
        (task) => task.state === "in_progress" && !task.responderOwned,
      );
      const pending = p?.tasks
        .filter((task) => task.state === "pending" && !task.responderOwned)
        .map((t) => `[${t.id}] ${t.title}`);
      const done = p?.tasks
        .filter((t) => t.state === "done" || t.state === "skipped")
        .map((t) => t.id);
      const jobBits = runningJobs.slice(0, 4).map((j) => {
        const cmd = (j.commandDisplay || j.command).replace(/\s+/g, " ").trim();
        return `${j.id} ${j.status} ${cmd.slice(0, 40)}`;
      });
      const snap: SessionStateSnapshot = {
        goal: p?.goal ?? prompt.slice(0, 160),
        projectRoot: root,
        packageManager: pm,
        planStatus: p?.status,
        planKind: p?.kind,
        openTask: open ? `[${open.id}] ${open.title}` : undefined,
        pendingTasks: pending,
        doneTasks: done,
        featureAppRequired: featureAppAsk,
        featureSeen: sawFeatureImplWrite,
        scaffoldOk: sawScaffoldOk,
        serverStarted: sawServerStart,
        serverProbedOk: sawLocalHttpProbe,
        lastProbeFailed: sawFailedLocalHttpProbe,
        lastOkTool: taskWorkLedger?.lastOkTool,
        backgroundJobs:
          jobBits.length > 0
            ? `${runningJobs.length} running: ${jobBits.join("; ")}`
            : undefined,
        engagementNote: pentestSession
          ? "remote/security engagement — no local dev server as completion"
          : undefined,
      };
      snap.nextHint = inferNextHint(snap);
      // One live plan copy, refreshed at the same protocol-safe points as
      // SESSION STATE so advancing tasks are never contradicted by a stale copy.
      if (p) {
        upsertPlanContextMessage(
          messages,
          planContextMessage(p, session.planApproved.value),
        );
      } else {
        removePlanContextMessage(messages);
      }
      upsertSessionStateMessage(messages, buildSessionStateBlock(snap));
    };
    refreshSessionState(activePlan);


    let pendingCalls: ToolCall[] = [];
    let narrowNmapDispatchCount = 0;
    // Multi-task sync guard state (recomputed per model message before execution).
    let batchRemindCalls = new Set<ToolCall>();
    let batchReminderNote = "";

    const deferredPostToolMessages: ChatMessage[] = [];
    /**
     * Successful job.read receipts update the durable ledger only after the
     * assistant→tool group closes. Inserting the ledger system row inside
     * executeSingleTool would split native tool protocol and cause repair to
     * replace the real acknowledgement body with a "No stored body" stub.
     */
    const deferredResponderLedgerNotifications: ResponderNotification[] = [];
    /**
     * Latest plan seen during tool execution. SESSION STATE is refreshed once
     * after the full tool batch is recorded — never mid-group (see
     * executeSingleTool / recordResult).
     */
    let pendingSessionStatePlan: SessionPlan | null | undefined = activePlan;


    const analysis = analyzeTask(prompt);
    const hasHistory = (options.history?.length ?? 0) > 0;
    const buildLike = buildLikeTurn;
    const pentestLike = looksLikePentestTask(prompt, options.history);
    let codingSession = codingSessionFromContext({
      buildLike,
      planKind: activePlan?.kind,
    });
    const continueExistingOutcome =
      /^(?:continue|resume|proceed|keep\s+going|finish|next)\b/i.test(prompt.trim()) ||
      Boolean(activePlan && !isPlanTerminal(activePlan));
    const outcomeState: OutcomeEnvelope = await openOutcomeState({
      sessionId: session.sessionId,
      userIntent: prompt,
      kind: inferOutcomeKind({ userIntent: prompt, buildLike, pentestLike }),
      continueExisting: continueExistingOutcome,
    });
    loopGuard.restoreCompletedOperations(outcomeState.completedOperations ?? []);
    await saveOutcomeState(outcomeState);
    // Canonical mutation/artifact ledger feeding the durable compaction envelope.
    const workLedger = new WorkLedger();
    let governorState: GovernorState = createGovernorState();
    let turnState: TurnStateSnapshot = createTurnState();
    const moveTurn = (to: TurnState, reason?: string): void => {
      if (turnState.state === to) return;
      try {
        turnState = transitionTurn(turnState, to, reason);
      } catch {
        // Recovery paths may skip an intermediate presentation state; route
        // active work through verifying/exploring rather than forging state.
        if (to === "succeeded" || to === "partial") {
          if (turnState.state === "understanding") {
            turnState = transitionTurn(
              turnState,
              "exploring",
              "response prepared for verification",
            );
          }
          if (turnState.state === "acting" || turnState.state === "exploring") {
            turnState = transitionTurn(turnState, "verifying", reason);
          }
          turnState = transitionTurn(turnState, to, reason);
        }
      }
    };
    let retryDependenciesChanged = false;
    let retryEnvironmentChanged = false;
    const stepBudget = computeStepBudget({
      analysis,
      maxSteps,
      buildLike,
      pentestLike,
      hasHistory,
    });
    // Iteration count is only an emergency protection for recovery/model loops;
    // normal continuation is governed by evidence and resource deltas above.
    const maxIterations = Math.max(210, computeMaxIterations(stepBudget));

    let productiveSteps = 0;
    let consecutiveModelOnlyRounds = 0;
    /** Successful file mutation this turn — kills false "error diagnosed but not fixed". */
    let sawSuccessfulMutation = false;
    let step = -1;
    let stepMaxTokens = 0;
    let nextToolEventId = 0;
    const alreadyPrintedIds = new Set<string>();

    const promptMutex = {
      promise: Promise.resolve(),
      async acquire(): Promise<() => void> {
        let release = () => { };
        const next = new Promise<void>((r) => {
          release = r;
        });
        const current = this.promise;
        this.promise = current.then(() => next);
        await current;
        return release;
      },
    };

    /**
     * Apply a salvaged partial write through the NORMAL tool path so the
     * classifier, scope/engagement gates, confirmation prompt, and receipts
     * all apply exactly as they would for a model-emitted call. Salvage must
     * never mutate a file with `confirmed: true`, and an `fs.append` that was
     * cut off must stay an append (with its precondition) instead of becoming
     * a full overwrite.
     */
    async function applySalvagedWrite(
      salvaged: SalvagedWrite,
    ): Promise<{
      ok: boolean;
      cancelled: boolean;
      output: string;
      bytesOnDisk: number;
    }> {
      const args: Record<string, unknown> = {
        path: salvaged.path,
        content: salvaged.content,
      };
      if (salvaged.operation === "append") {
        args.position = "end";
        if (typeof salvaged.expectedPriorBytes === "number") {
          args.expectedPriorBytes = salvaged.expectedPriorBytes;
        }
      }
      const call: ToolCall = {
        name: salvaged.operation === "append" ? "fs.append" : "fs.write",
        args,
      };
      const eventId = `tool-${++nextToolEventId}`;
      const res = await executeSingleTool(
        call,
        eventId,
        options.signal || new AbortController().signal,
      );
      const ok = res.ok && res.result.ok;
      let bytesOnDisk = Buffer.byteLength(salvaged.content, "utf8");
      if (ok) {
        try {
          const stats = await stat(resolveFsToolPath(salvaged.path));
          bytesOnDisk = stats.size;
        } catch {
          // Keep the content-length estimate when the file cannot be stat'ed.
        }
      }
      return {
        ok,
        cancelled: Boolean(res.blockOrCancel),
        output: res.result.output,
        bytesOnDisk,
      };
    }

    async function executeSingleTool(
      rawCall: ToolCall,
      toolEventId: string,
      parentSignal: AbortSignal,
    ): Promise<{
      ok: boolean;
      call: ToolCall;
      result: ToolResult;
      contextOutput: string;
      lastAnswer?: string | undefined;
      aborted?: boolean | undefined;
      suppressedRepeat?: boolean | undefined;
      blockOrCancel?: boolean | undefined;
    }> {

      const scratchDir = scratchDirFor(safeCwd());
      let call = normalizeToolCall(rawCall);

      const emitVisibleSyntheticReceipt = (
        result: ToolResult,
        summary: string,
      ): void => {
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
          alreadyPrintedIds.add(toolEventId);
        }
        emit({ type: "tool-start", id: toolEventId });
        const output = result.output.endsWith("\n")
          ? result.output
          : `${result.output}\n`;
        writeToolOutput(toolEventId, output);
        emitToolResult(toolEventId, result, summary);
      };

      let dispatchedTaskId: string | undefined;
      let delegation: { id: string; taskId?: string } | undefined;
      let engagementLease: PolicyLease | undefined;
      let engagementGraph: EngagementGraph | undefined;
      let engagementRecord: EngagementActionRecord | undefined;

      if (call.args?.__nativeParseError) {
        const raw = String(call.args._raw ?? "").slice(0, 200);
        const reason =
          "Tool call arguments were not valid JSON (truncated or malformed). " +
          "Retry with smaller content, or use fs.writeMany / fs.append continuation. " +
          (raw ? `Partial: ${raw}` : "");
        const result = { ok: false, output: reason, exitCode: 1 };
        emitToolResult(toolEventId, result, reason);
        return { ok: false, call, result, contextOutput: reason };
      }

      const elidedStub = findElidedStubArg(call.args);
      if (elidedStub) {
        const reason = elidedStubReuseMessage(elidedStub.key);
        const result = { ok: false, output: reason, exitCode: 1 };
        emitToolResult(toolEventId, result, reason);
        return { ok: false, call, result, contextOutput: reason };
      }

      if (call.name === "image.ocr" && !imageOcrEnabled) {
        writeNotice(
          "info",
          "skipped OCR because the original image is attached to the vision model",
        );
        const recoveryText =
          "The original image is attached to this message and you can inspect it directly. " +
          "Do not call image.ocr or infer text from OCR. Answer the user's question from the actual image pixels now.";
        const result = { ok: true, output: recoveryText };
        return { ok: true, call, result, contextOutput: recoveryText };
      }

      if (narrowNmapOperation) {
        const allowed = new Set([
          "net.scan",
          "shell.tail",
          "shell.jobs",
          "job.read",
          "task.read",
        ]);
        if (!allowed.has(call.name)) {
          const reason =
            `Narrow nmap request: ${call.name} was not run because the user requested only one nmap operation. ` +
            `Call net.scan with the requested target/options; do not create a plan or add DNS, WHOIS, HTTP, recon, or vulnerability steps.`;
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
        if (call.name === "net.scan") {
          if (narrowNmapDispatchCount >= 1) {
            const reason =
              "Narrow nmap request: a scan has already been dispatched this turn. " +
              "Do not broaden or retry it automatically; report the existing result/job status and ask before another scan.";
            const result = { ok: false, output: reason, exitCode: 1 };
            emitToolResult(toolEventId, result, reason);
            return { ok: false, call, result, contextOutput: reason };
          }
          narrowNmapDispatchCount += 1;
        }
      }

      // Held batch task update: one reminder for the whole simultaneous set,
      // no execution, until the model re-issues the identical batch to confirm.
      if (call.name === "task.update" && batchRemindCalls.has(rawCall)) {
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
          alreadyPrintedIds.add(toolEventId);
        }
        const result = { ok: false, output: batchReminderNote, exitCode: 1 };
        emitToolResult(toolEventId, result, batchReminderNote);
        writeToolOutput(toolEventId, "held\n");
        return { ok: false, call, result, contextOutput: batchReminderNote };
      }

      const retryReasonRaw = call.args._retryReason;
      const retryReason =
        retryReasonRaw && typeof retryReasonRaw === "object"
          ? {
            code: String((retryReasonRaw as Record<string, unknown>).code ?? ""),
            detail: String((retryReasonRaw as Record<string, unknown>).detail ?? ""),
          }
          : undefined;
      const currentProbeState = probeStateKey(call);
      const loopCheck = loopGuard.shouldBlock(call.name, call.args, {
        dependenciesChanged: retryDependenciesChanged,
        environmentChanged: retryEnvironmentChanged,
        ...(currentProbeState ? { stateKey: currentProbeState } : {}),
        ...(retryReason ? { retryReason } : {}),
      });
      if (loopCheck.block) {
        const baseReason =
          loopCheck.reason ??
          `${call.name} previously failed with identical arguments. Change the command/args and retry.`;
        const priorObservation =
          loopCheck.kind === "unchanged-success"
            ? loopGuard.getPriorObservation(call.name, call.args)
            : undefined;
        const reason = priorObservation
          ? `${baseReason}\n\nPrior successful result (reuse this; it is the result of the requested call):\n${priorObservation}`
          : baseReason;
        if (loopCheck.kind === "unchanged-success") {
          const result: ToolResult = { ok: true, output: reason, exitCode: 0 };
          emitVisibleSyntheticReceipt(result, reason);
          return {
            ok: true,
            call,
            result,
            contextOutput: reason,
            suppressedRepeat: true,
          };
        }
        writeNotice("warn", reason);
        const result = { ok: false, output: reason, exitCode: 1 };
        emitToolResult(toolEventId, result, reason);
        return {
          ok: false,
          call,
          result,
          contextOutput: reason,
        };
      }

      if (call.name === "loop.reset") {
        loopGuard.resetAllSequenceCounts();
        const output = "Loop guard counters reset. You may re-run commands freely.";
        const result: ToolResult = { ok: true, output, exitCode: 0 };
        emitVisibleSyntheticReceipt(result, output);
        loopGuard.recordAttempt(step, call.name, call.args, true, 0, output);
        return { ok: true, call, result, contextOutput: output };
      }

      if (RUNNER_META_TOOL_NAMES.has(call.name)) {
        if (call.name === "job.read" || call.name === "task.read") {
          const requestedNotificationId =
            typeof call.args.notificationId === "string"
              ? call.args.notificationId.trim()
              : "";
          const requestedJobId =
            typeof call.args.jobId === "string" ? call.args.jobId.trim() : "";
          const pending = jobManager.getPendingNotifications(session.sessionId);
          const eligible = responderWakeTurn
            ? pending.filter(matchesWakeRevision)
            : pending;
          const byNotification = requestedNotificationId
            ? eligible.find((candidate) => candidate.id === requestedNotificationId)
            : undefined;
          const byJob = requestedJobId
            ? eligible.find((candidate) => candidate.jobId === requestedJobId)
            : undefined;
          const identifiersConflict = Boolean(
            (byNotification && requestedJobId && byNotification.jobId !== requestedJobId) ||
              (byJob && requestedNotificationId && byJob.id !== requestedNotificationId),
          );
          const notification = identifiersConflict
            ? undefined
            : (byNotification ?? byJob);
          const visible = Boolean(
            notification && unreadResponderNotificationIds.has(notification.id),
          );
          const wakeIdentityMatches = Boolean(
            responderWakeTurn &&
              (requestedNotificationId || requestedJobId) &&
              (!requestedNotificationId ||
                requestedNotificationId === responderWakeNotificationId) &&
              (!requestedJobId || requestedJobId === responderWakeJobId),
          );
          const staleWakeSettled =
            wakeIdentityMatches && !identifiersConflict && !notification;
          const persistedRead = Boolean(
            notification &&
              visible &&
              jobManager.markRead(notification.id, session.sessionId),
          );
          const marked = persistedRead || staleWakeSettled;
          const identifier = requestedJobId || requestedNotificationId;
          const revisionLabel = responderWakeResultRevision
            ? ` revision ${responderWakeResultRevision}`
            : "";
          const output = persistedRead
            ? `Responder job ${notification!.jobId} (${notification!.id}) marked delivered and read after model analysis.`
            : staleWakeSettled
              ? `Responder result ${identifier}${revisionLabel} was already settled or discarded; the stale wake is acknowledged idempotently.`
              : !requestedNotificationId && !requestedJobId
                ? `${call.name} failed: jobId or notificationId is required.`
                : identifiersConflict
                  ? `${call.name} failed: jobId and notificationId refer to different Responder results.`
                  : !notification
                    ? `${call.name} failed: Responder result ${identifier} is unavailable, consumed, or archived.`
                    : !visible
                      ? `${call.name} failed: Responder result ${identifier} was not delivered to this model turn. Analyze a delivered result before marking it read.`
                      : `${call.name} failed: read state for Responder result ${identifier} could not be persisted.`;
          if (persistedRead && notification) {
            deferredResponderLedgerNotifications.push(notification);
            unreadResponderNotificationIds.delete(notification.id);
          } else if (staleWakeSettled && responderWakeNotificationId) {
            unreadResponderNotificationIds.delete(responderWakeNotificationId);
          }
          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }
          const result = {
            ok: marked,
            output,
            ...(marked ? {} : { exitCode: 1 }),
          };
          loopGuard.recordAttempt(step, call.name, call.args, marked, 0);
          emitToolResult(toolEventId, result, output);
          writeToolOutput(toolEventId, marked ? "read\n" : "failed\n");
          return {
            ok: marked,
            call,
            result,
            contextOutput: output,
          };
        }

        // Evidence gate: refuse done until at least one successful work tool
        // ran under this task (model must see results and be satisfied).
        if (call.name === "task.update") {
          const stateRaw =
            typeof call.args.state === "string" ? call.args.state : "";
          const taskIdRaw =
            typeof call.args.taskId === "string"
              ? call.args.taskId
              : typeof call.args.id === "string"
                ? call.args.id
                : "";
          if (stateRaw === "done" && taskIdRaw) {
            const live = await loadPlan(session.sessionId).catch(() => undefined);
            const resolved =
              (live ? resolvePlanTaskId(live, taskIdRaw) : undefined) ??
              taskIdRaw;
            const target = live?.tasks.find((task) => task.id === resolved);
            // Soft-auto: pending + deps complete is allowed through to plan-tool,
            // which will open then complete in one call. Only hard-block when
            // the task is not ready for that path (failed / deps / missing).
            const depsIncomplete =
              target?.dependencies?.some((dependency) => {
                const dependencyTask = live?.tasks.find((t) => t.id === dependency);
                return (
                  !dependencyTask ||
                  (dependencyTask.state !== "done" && dependencyTask.state !== "skipped")
                );
              }) ?? false;
            const canSoftComplete =
              target?.state === "pending" && !depsIncomplete;
            const gate = !live
              ? {
                ok: false as const,
                reason: `Task ${resolved} cannot be marked done because its active plan is unavailable.`,
              }
              : target?.state === "in_progress" || canSoftComplete
                ? completionGateForTask(live, resolved)
                : target?.state === "failed"
                  ? {
                    ok: false as const,
                    reason: `Task ${resolved} is failed — retry with in_progress first, then mark done after recovery work.`,
                  }
                  : {
                    ok: false as const,
                    reason: `Task ${resolved} must be in_progress before it can be marked done. Start or retry the task, perform fresh work, then complete it.`,
                  };
            if (!gate.ok) {
              writeNotice("warn", gate.reason);
              if (!alreadyPrintedIds.has(toolEventId)) {
                writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
                alreadyPrintedIds.add(toolEventId);
              }
              const result = {
                ok: false,
                output: gate.reason,
                exitCode: 1,
              };
              emitToolResult(toolEventId, result, gate.reason);
              writeToolOutput(toolEventId, "failed\n");
              return {
                ok: false,
                call,
                result,
                contextOutput: gate.reason,
              };
            }
          }
        }

        const planResult = await handlePlanTool(call, session, {
          loopGuard,
          step,
          autoApprove: !isPlanMode,
        });
        if (planResult.handled) {
          if (!planResult.reminder) {
            loopGuard.recordAttempt(step, call.name, call.args, planResult.ok, 0);
          }

          if (planResult.ok && call.name === "task.update") {
            const stateRaw =
              typeof call.args.state === "string" ? call.args.state : "";
            const taskIdRaw =
              typeof call.args.taskId === "string"
                ? call.args.taskId
                : typeof call.args.id === "string"
                  ? call.args.id
                  : "";
            const resolved =
              (planResult.plan
                ? resolvePlanTaskId(planResult.plan, taskIdRaw)
                : undefined) ?? taskIdRaw;
            if (stateRaw === "in_progress" && resolved) {
              // Keep accumulated evidence when recon already credited this task
              // before an explicit in_progress (common on pentest plans).
              // Also absorb turn-level preflight (tool.check before open).
              const persisted = planResult.plan?.tasks.find(
                (task) => task.id === resolved,
              );
              const baseLed =
                taskWorkLedger?.taskId === resolved
                  ? taskWorkLedger
                  : ledgerFromTaskEvidence(resolved, persisted?.evidence);
              const led =
                absorbLooseWorkIntoLedger(
                  baseLed,
                  resolved,
                  persisted?.title ?? "",
                  sessionLooseWork,
                  { planKind: planResult.plan?.kind },
                ) ?? baseLed;
              taskWorkLedger = led;
              if (planResult.plan && led && led.successWorkCount > 0 && persisted) {
                persisted.evidence = taskEvidenceFromLedger(led);
                await persistTaskEvidence(persisted.id, persisted.evidence);
              }
            } else if (stateRaw === "done" && resolved) {
              // Persist absorbed evidence before clearing the live ledger.
              if (planResult.plan && taskWorkLedger?.taskId === resolved) {
                const t = planResult.plan.tasks.find((x) => x.id === resolved);
                if (t) {
                  t.evidence = taskEvidenceFromLedger(taskWorkLedger);
                  await persistTaskEvidence(t.id, t.evidence);
                }
              }
              taskWorkLedger = null;
            } else if (
              (stateRaw === "failed" || stateRaw === "skipped") &&
              taskWorkLedger?.taskId === resolved
            ) {
              taskWorkLedger = null;
            }
          }

          if (planResult.ok && planResult.plan) {
            // Keep the batch-end SESSION STATE aligned with successful plan
            // transitions. Otherwise a completed task can still appear open
            // on the next model round and trigger duplicate work.
            pendingSessionStatePlan = planResult.plan;
          }

          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }

          if (planResult.reminder && planResult.toast) {
            writeNotice("warn", planResult.toast);
          }

          if (planResult.plan) {
            writePlanUpdate(planResult.plan);
            // Refresh sticky root only if path already exists (not bare Desktop).
            const root = extractProjectRootFromPlan(planResult.plan);
            if (root) setActiveProjectRootIfValid(root);
          }

          if (planResult.ok && planResult.cleared) {
            pendingSessionStatePlan = null;
            removePlanContextMessage(messages);
            emit({ type: "plan-cleared", sessionId: session.sessionId });
            if (writesDirectly) process.stdout.write(planResult.display);
          }

          const result = { ok: planResult.ok, output: planResult.modelNote };
          emitToolResult(toolEventId, result, planResult.modelNote);
          writeToolOutput(toolEventId, result.ok ? "ok\n" : "failed\n");

          return {
            ok: planResult.ok,
            call,
            result,
            contextOutput: planResult.modelNote,
          };
        }
      }

      const scope = await loadScope();
      const decision = classifyToolCall(call, { scope });
      await auditLog("tool.classified", {
        call,
        decision,
        scope: isScopeActive(scope) ? (scope.name ?? "(unnamed)") : "(none)",
      });

      const livePlanForPreGate = await loadPlan(session.sessionId).catch(
        () => undefined,
      );

      // Plan mode: gather freely while the draft awaits accept. Once the user
      // approves (planApproved), mutates must run even if mode still says "plan"
      // for a beat — otherwise implement loops forever on gather-only blocks.
      if (
        isPlanMode &&
        !session.planApproved.value &&
        !isScratchOnlyWrite(call, scratchDir)
      ) {
        const cmd =
          call.name === "terminal.send"
            ? typeof call.args.text === "string"
              ? call.args.text
              : ""
            : typeof call.args.command === "string"
              ? call.args.command
              : "";
        const shellBlocked =
          call.name === "terminal.start" ||
          call.name === "terminal.send" ||
          ((call.name === "shell.exec" || call.name === "shell.start") &&
            !isPlanModeAllowedShellCommand(cmd));
        const allowed = isPlanModeAllowedTool(call.name) && !shellBlocked;
        if (!allowed) {
          const reason =
            `plan mode — ${call.name} is blocked (gather-only). ` +
            `Use any recon/enum/scan/research tool; do not write project files or run active exploits. ` +
            `Put exploit/implement steps in plan.create tasks for after accept. ` +
            `Accept the plan (y/i or /implement) to switch to agent and execute.`;
          writeNotice("warn", reason);
          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          writeToolOutput(toolEventId, "failed\n");
          return {
            ok: false,
            call,
            result,
            contextOutput: reason,
          };
        }
      }

      const isMutatingAction =
        (decision.level === "confirm" || decision.level === "block") &&
        !isPreApprovalAllowedTool(call.name) &&
        !isScratchOnlyWrite(call, scratchDir);

      if (isMutatingAction) {
        const planNow =
          livePlanForPreGate ??
          (await loadPlan(session.sessionId).catch(() => undefined));
        if (planNow && !session.planApproved.value) {
          const reason = `plan awaiting approval — ${call.name} is blocked until the plan is accepted (/implement or Accept)`;
          writeNotice("warn", reason);
          const result = { ok: false, output: reason, exitCode: 1 };
          return {
            ok: false,
            call,
            result,
            contextOutput: reason,
            blockOrCancel: true,
          };
        }
      }


      if (session.planApproved.value) {
        const livePlanForGate = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlanForGate) {
          const unfinished = livePlanForGate.tasks.some(
            (task) =>
              !task.responderOwned &&
              (task.state === "pending" || task.state === "in_progress"),
          );
          const inProgress = livePlanForGate.tasks.find(
            (task) => task.state === "in_progress" && !task.responderOwned,
          );
          if (unfinished && !inProgress) {
            // tool.check / fs.list preflight: allow without auto-opening a task
            // (auto-start on preflight made models skip task.update and confused scope).
            const skipTaskGate =
              isPlanPreflightTool(call.name) ||
              (livePlanForGate.kind === "pentest" &&
                isReadOnlyReconTool(call.name));
            if (skipTaskGate) {
              // fall through
            } else {
              const pending = readyPlanTasks(livePlanForGate);
              // Title/command matching is only a soft ownership hint. If no
              // heuristic matches, preserve plan order instead of blocking.
              const nextPending =
                pickPendingTaskForToolCall(
                  pending,
                  call,
                  livePlanForGate.tasks.map((t) => t.title),
                ) ?? pending[0];
              if (nextPending) {
                markTask(livePlanForGate, nextPending.id, "in_progress");
                if (
                  livePlanForGate.status === "draft" ||
                  livePlanForGate.status === "approved"
                ) {
                  livePlanForGate.status = "in_progress";
                }
                // Opening a task is a transition applied by
                // the reducer, which also enforces the single-active invariant.
                await mutatePlan(session.sessionId, (draft) => {
                  const target = draft.tasks.find(
                    (candidate) => candidate.id === nextPending.id,
                  );
                  if (!target || target.state === "in_progress") return false;
                  target.state = "in_progress";
                  if (draft.status === "draft" || draft.status === "approved") {
                    draft.status = "in_progress";
                  }
                  return true;
                }).catch(() => undefined);
                // Preserve evidence already credited to this task (e.g. pentest
                // recon that ran before the task was formally opened).
                if (
                  !taskWorkLedger ||
                  taskWorkLedger.taskId !== nextPending.id
                ) {
                  taskWorkLedger = ledgerFromTaskEvidence(
                    nextPending.id,
                    nextPending.evidence,
                  );
                }
                writePlanUpdate(livePlanForGate);
                writeNotice(
                  "info",
                  `auto-started [${nextPending.id}] so work can continue`,
                );
              }
            }
          }
        }
      }


      call = applyDestinationCwd(
        call,
        destinationHint ?? getActiveProjectRoot(),
      );

      // Soft preflight: refuse scaffold into an existing non-empty project
      // (avoids endless "Operation cancelled" retries across all stacks).
      if (
        (call.name === "shell.exec" || call.name === "shell.start") &&
        typeof call.args.command === "string" &&
        isScaffoldCreateCommand(call.args.command)
      ) {
        const cwdArg =
          typeof call.args.cwd === "string" ? call.args.cwd : undefined;
        const conflict = scaffoldTargetConflictMessage(
          call.args.command,
          cwdArg,
        );
        if (conflict) {
          const target = resolveScaffoldTargetPath(call.args.command, cwdArg);
          const materialized = scaffoldLooksMaterialized(target);
          if (target && materialized && setActiveProjectRootIfValid(target, { force: true })) {
            await persistProjectRootOnPlan(target);
          }
          const message = materialized
            ? `Scaffold skipped: the target already contains a usable project${target ? ` at ${target}` : ""}. Continue that project directly; do not re-run the scaffolder.`
            : `Scaffold was not run: the existing target${target ? ` at ${target}` : ""} is incomplete. Inspect and repair it before completing the scaffold task; do not retry the scaffolder into this non-empty directory.`;
          writeNotice("info", message);
          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }
          const result = { ok: true, output: message, exitCode: 0 };
          emitToolResult(toolEventId, result, message);
          writeToolOutput(toolEventId, "ok\n");
          return {
            ok: true,
            call,
            result,
            contextOutput: message,
          };
        }
      }

      if (!alreadyPrintedIds.has(toolEventId)) {
        writeToolCall(
              toolEventId,
              call,
              styleToolChatter(
                call,
                chalk.cyan(`  ▶ ${call.name}`) +
                  chalk.gray(` ${formatToolArgs(call)}`),
              ) + "\n",
            );
        alreadyPrintedIds.add(toolEventId);
      }

      const scopeTarget = safeScopeTargetForToolCall(call);
      const engagementActions =
        pentestSession || isPentestToolCall(call) || Boolean(scope)
          ? safeEngagementActionsForToolCall(call)
          : [];
      // The primary action carries the URL/port/path detail used for leases and
      // network-hop authorization; every action (one per named target) must pass
      // the scope check below before the tool runs.
      const engagementAction = engagementActions[0];
      let engagementDecision:
        | ReturnType<typeof evaluateEngagementAction>
        | undefined;
      for (const action of engagementActions) {
        const decisionForAction = evaluateEngagementAction(scope, action);
        if (!decisionForAction) continue;
        if (action === engagementAction) engagementDecision = decisionForAction;
        if (scope) {
          engagementGraph = await openEngagement(scope);
          engagementRecord = beginEngagementAction(engagementGraph, {
            tool: call.name,
            target: decisionForAction.normalizedTarget || action.target,
            phase: decisionForAction.phase,
            capability: decisionForAction.capability,
            authorized: decisionForAction.allowed,
            reason: decisionForAction.reason,
          });
          await saveEngagement(engagementGraph);
        }
        await auditLog("engagement.policy", {
          ...(engagementGraph ? { engagementId: engagementGraph.id } : {}),
          ...(engagementRecord ? { actionId: engagementRecord.id } : {}),
          tool: call.name,
          target: decisionForAction.normalizedTarget,
          phase: decisionForAction.phase,
          capability: decisionForAction.capability,
          allowed: decisionForAction.allowed,
          reason: decisionForAction.reason,
        });
        if (!decisionForAction.allowed) {
          const target =
            decisionForAction.normalizedTarget ||
            action.target ||
            scopeTarget ||
            "requested target";
          const reason = outOfScopeToolMessage({
            target,
            reason: decisionForAction.reason,
            allowed: scope?.authorizedTargets,
          });
          writeToolBlocked(toolEventId, call.name, reason);
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
      }

      if (decision.level === "block") {
        writeToolBlocked(toolEventId, call.name, decision.reason);
        const message = `Blocked: ${call.name} — ${decision.reason}`;
        const result = { ok: false, output: message, exitCode: 1 };

        return {
          ok: false,
          call,
          result,
          contextOutput: `${message}\nThis tool call did not run. Continue the task using a safer allowed method; do not retry the same blocked command unchanged.`,
        };
      }

      let authorized = true;
      let pentestJustConfirmed = false;

      const releasePrompt = await promptMutex.acquire();
      try {
        parentSignal.throwIfAborted();
        const needsPentestAuth =
          isPentestToolCall(call) &&
          !getConfig().pentestAuthorized &&
          !session.pentestAuthorized.value;
        authorized = await ensurePentestAuthorization(
          call,
          Boolean(options.autoConfirm),
          session,
          confirmPort,
        );
        restoreInteractiveStdin();
        if (!authorized) {
          const lastAnswer = "Pentest authorization not confirmed.";
          writeToolBlocked(toolEventId, call.name, lastAnswer);
          const result = { ok: false, output: lastAnswer, exitCode: 1 };
          return {
            ok: false,
            call,
            result,
            contextOutput: lastAnswer,
            lastAnswer,
            blockOrCancel: true,
          };
        }
        if (needsPentestAuth) {
          pentestJustConfirmed = true;
        }

        // fs.delete always confirms (every permission level). Out-of-cwd
        // writes confirm under default permissions; allow-all auto-approves.
        let forceConfirm = call.name === "fs.delete";
        if (
          call.name === "fs.write" ||
          call.name === "fs.writeMany" ||
          call.name === "fs.edit" ||
          call.name === "fs.append" ||
          call.name === "fs.replaceLines" ||
          call.name === "fs.delete"
        ) {
          const paths: string[] = [];
          if (typeof call.args.path === "string") paths.push(call.args.path);
          if (Array.isArray(call.args.files)) {
            for (const entry of call.args.files) {
              if (
                entry &&
                typeof entry === "object" &&
                typeof (entry as { path?: unknown }).path === "string"
              ) {
                paths.push((entry as { path: string }).path);
              }
            }
          }
          for (const p of paths) {
            try {
              if (isOutsideWorkingDirectory(resolveFsToolPath(p))) {
                forceConfirm = true;
                break;
              }
            } catch {
              forceConfirm = true;
              break;
            }
          }
        }

        if (
          (decision.level === "confirm" || forceConfirm) &&
          !pentestJustConfirmed
        ) {
          const ok = await confirmToolExecution(
            call,
            forceConfirm ? false : Boolean(options.autoConfirm),
            session,
            confirmPort,
            forceConfirm ? { forceConfirm: true } : undefined,
          );
          restoreInteractiveStdin();
          if (!ok) {
            const lastAnswer = "Cancelled.";
            writeToolBlocked(toolEventId, call.name, lastAnswer);
            const result = { ok: false, output: lastAnswer, exitCode: 1 };
            return {
              ok: false,
              call,
              result,
              contextOutput: lastAnswer,
              lastAnswer,
              blockOrCancel: true,
            };
          }
        }
      } finally {
        releasePrompt();
      }

      parentSignal.throwIfAborted();
      const planAtDispatch = await loadPlan(session.sessionId).catch(
        () => undefined,
      );
      dispatchedTaskId = planAtDispatch?.tasks.find(
        (task) => task.state === "in_progress" && !task.responderOwned,
      )?.id;
      if (!dispatchedTaskId && planAtDispatch?.kind === "pentest") {
        const candidate = pickPendingTaskForToolCall(
          readyPlanTasks(planAtDispatch),
          call,
          planAtDispatch.tasks.map((task) => task.title),
        );
        dispatchedTaskId = candidate?.id;
      }
      // An explicitly declared responder parent wins over inference.
      const declaredParent = readDeclaredParentTaskId(call);
      if (declaredParent) {
        const resolvedParent = resolveResponderParent({
          plan: planAtDispatch,
          declared: declaredParent,
          activeForegroundTaskIds: dispatchedTaskId ? [dispatchedTaskId] : [],
        });
        if (!resolvedParent.ok) {
          const reason = `${call.name} failed: ${resolvedParent.reason}`;
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
        dispatchedTaskId = resolvedParent.taskId ?? dispatchedTaskId;
      }
      // For an explicit delegation, create the child subtask before the
      // Process starts and launch the job already bound to it. The job therefore
      // Never carries the foreground parent in `taskId`, and settlement has a
      // Durable row to advance even if this turn dies right after spawn.
      if (isExplicitResponderDelegation(call) && planAtDispatch) {
        delegation = { id: `dg-${randomUUID().slice(0, 8)}` };
        const created = await mutatePlan(session.sessionId, (draft) => {
          const parentExists =
            !!dispatchedTaskId &&
            draft.tasks.some((task) => task.id === dispatchedTaskId);
          const child = appendPlanTask(draft, {
            title: delegationTaskTitle(call),
            state: "in_progress",
            note: `delegation=${delegation!.id} awaiting launch`,
            dependencies: [],
            resourceLocks: [],
            ...(parentExists ? { parentTaskId: dispatchedTaskId } : {}),
            responderOwned: true,
            delegationId: delegation!.id,
          });
          delegation!.taskId = child.id;
          return true;
        }).catch(() => undefined);
        if (!created?.ok || !delegation.taskId) {
          delegation = undefined;
          writeNotice(
            "warn",
            "Responder delegation record could not be persisted — the job will be linked after launch",
          );
        } else if (created.plan) {
          pendingSessionStatePlan = created.plan;
          writePlanUpdate(created.plan);
        }
      }
      if (
        dispatchedTaskId &&
        (!taskWorkLedger || taskWorkLedger.taskId !== dispatchedTaskId)
      ) {
        const dispatchedTask = planAtDispatch?.tasks.find(
          (task) => task.id === dispatchedTaskId,
        );
        taskWorkLedger = ledgerFromTaskEvidence(
          dispatchedTaskId,
          dispatchedTask?.evidence,
        );
      }
      if (engagementAction) {
        engagementLease = engagementPolicy.acquire(scope, engagementAction);
        if (!engagementLease.decision.allowed) {
          const target = engagementLease.decision.normalizedTarget || engagementAction.target;
          const reason = outOfScopeToolMessage({
            target,
            reason: engagementLease.decision.reason,
            allowed: scope?.authorizedTargets,
          });
          const result = { ok: false, output: reason, exitCode: 1 };
          emitToolResult(toolEventId, result, reason);
          return { ok: false, call, result, contextOutput: reason };
        }
      }
      if (turnState.state === "understanding" || turnState.state === "exploring") {
        moveTurn("acting", `executing ${call.name}`);
      }
      options.onToolStart?.(call);
      // Card was "queued" since writeToolCall; flip to running only when work starts.
      emit({ type: "tool-start", id: toolEventId });
      writeStatus(call.name);

      // Elevation uses the secure secret modal (TUI) or is refused — never
      // a raw TTY "Password:" that freezes the UI. No misleading notice.

      const toolAc = new AbortController();
      const onParentAbort = () => toolAc.abort();
      parentSignal.addEventListener("abort", onParentAbort);

      let result: ToolResult;
      let liveBytes = 0;
      // Stream every live byte — never drop mid-run. After the tool finishes we
      // still replace the spool with the authoritative full `result.output`.
      const printLive = (chunk: string): void => {
        if (
          call.name === "fs.read" ||
          call.name === "fs.list" ||
          call.name === "fs.search"
        )
          return;
        if (!chunk) return;
        liveBytes += chunk.length;
        const indented = chunk.replace(/\r/g, "").replace(/\n(?!$)/g, "\n  ");
        const body = indented.startsWith("\n") ? indented : `  ${indented}`;
        writeToolOutput(toolEventId, chunk);
      };

      const jobId = randomUUID().slice(0, 8);
      const emptyJobArtifact = () => ({
        path: "",
        chunks: [] as string[],
        bytes: 0,
        droppedBytes: 0,
        redacted: false,
        sha256: "",
      });
      const backgroundJob: BackgroundJob = {
        id: jobId,
        command: `${call.name} ${formatToolArgs(call)}`,
        commandDisplay: `${call.name} ${formatToolArgs(call)}`,
        cwd: safeCwd(),
        status: "running",
        startedAt: new Date().toISOString(),
        artifactPath: "",
        stdoutArtifact: "",
        stderrArtifact: "",
        artifacts: { stdout: emptyJobArtifact(), stderr: emptyJobArtifact() },
        redactionProfile: "provider-secrets-v1",
        ownerSessionId: session.sessionId,
        // Tool-stall tracker only — must never show up in shell.jobs.
        kind: "ephemeral",
      };
      jobManager.registerJob(jobId, backgroundJob, toolAc);


      const TOOL_STALL_ABORT_MS = toolStallBudgetMs(call);
      const TOOL_HARD_BUDGET_MS = toolHardBudgetMs(call);
      const stallSecs = Math.round(TOOL_STALL_ABORT_MS / 1000);
      const hardSecs = Math.round(TOOL_HARD_BUDGET_MS / 1000);
      let stallTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let stalledByWatchdog = false;
      let hardTimedOut = false;
      let forceSettled = false;
      const resetStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (!toolAc.signal.aborted) {
            stalledByWatchdog = true;
            writeNotice(
              "warn",
              `${call.name} has been running for >${stallSecs}s without output — cancelling stalled tool`,
            );
            toolAc.abort();
          }
        }, TOOL_STALL_ABORT_MS);
        // Node: do not keep the process alive solely for the stall timer.
        (stallTimer as unknown as { unref?: () => void }).unref?.();
      };
      resetStallTimer();

      /**
       * Force-settle a hung tool promise after abort or hard budget.
       * Some transports ignore AbortSignal; without this race the agent
       * could freeze for minutes after "cancelling stalled tool".
       */
      const runToolWithForcedSettle = (): Promise<ToolResult> => {
        const work = runToolCall(call, {
          signal: toolAc.signal,
          requestSecret: options.requestSecret ?? stdioSecretRequester,
          onOutput: (chunk) => {
            if (toolAc.signal.aborted) return;
            resetStallTimer();
            printLive(chunk);
          },
          confirmed: true,
          userPrompt: prompt,
          // image.view needs the active route to check vision support and size
          // images to the provider's per-image budget.
          llmProvider: provider,
          llmModel: model,
          sessionId: session.sessionId,
          ...(delegation?.taskId ? { taskId: delegation.taskId } : {}),
          ...(delegation ? { delegationId: delegation.id } : {}),
          ...(dispatchedTaskId ? { parentTaskId: dispatchedTaskId } : {}),
          wakeOnCompletion: true,
          monitor: {
            toolName: call.name,
            toolEventId,
          },
          ...(engagementAction && scope
            ? {
              engagementAuthorization: {
                target: engagementDecision?.normalizedTarget || engagementAction.target,
                ...(scope.expiresAt ? { expiresAt: scope.expiresAt } : {}),
              },
              authorizeNetworkHop: async (url: string, resolvedAddresses: string[]) => {
                const hop = actionFromUrl({
                  url,
                  method: engagementAction.method,
                  phase: engagementAction.phase,
                  capability: engagementAction.capability,
                  resolvedAddresses,
                });
                const hopDecision = evaluateEngagementAction(scope, hop);
                await auditLog("engagement.policy.hop", {
                  ...(engagementGraph ? { engagementId: engagementGraph.id } : {}),
                  ...(engagementRecord ? { actionId: engagementRecord.id } : {}),
                  url,
                  resolvedAddresses,
                  allowed: hopDecision.allowed,
                  reason: hopDecision.reason,
                });
                return { allowed: hopDecision.allowed, reason: hopDecision.reason };
              },
            }
            : {}),
        });

        return new Promise<ToolResult>((resolve, reject) => {
          let settled = false;
          const finishOk = (r: ToolResult): void => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            resolve(r);
          };
          const finishErr = (err: unknown): void => {
            if (settled) return;
            settled = true;
            if (graceTimer) clearTimeout(graceTimer);
            reject(err);
          };
          const forceCancelResult = (): ToolResult => {
            forceSettled = true;
            if (stalledByWatchdog) {
              return {
                ok: false,
                output: `Tool timed out after ${stallSecs}s without output (force-cancelled).`,
                exitCode: 124,
              };
            }
            if (hardTimedOut) {
              return {
                ok: false,
                output: `Tool hard-timeout after ${hardSecs}s — cancelled.`,
                exitCode: 124,
              };
            }
            return {
              ok: false,
              output: "Tool aborted before it could complete (force-cancelled).",
              exitCode: 130,
            };
          };
          const armGraceForceSettle = (): void => {
            if (settled || graceTimer) return;
            graceTimer = setTimeout(() => {
              if (settled) return;
              writeNotice(
                "warn",
                `${call.name} did not stop after cancel — force-settling`,
              );
              finishOk(forceCancelResult());
            }, TOOL_ABORT_GRACE_MS);
            (graceTimer as unknown as { unref?: () => void }).unref?.();
          };

          work.then(finishOk, finishErr);

          // Hard wall-clock: abort + force-settle after budget.
          hardTimer = setTimeout(() => {
            if (settled) return;
            hardTimedOut = true;
            writeNotice(
              "warn",
              `${call.name} exceeded ${hardSecs}s hard budget — cancelling`,
            );
            if (!toolAc.signal.aborted) toolAc.abort();
            armGraceForceSettle();
          }, TOOL_HARD_BUDGET_MS);
          (hardTimer as unknown as { unref?: () => void }).unref?.();

          // After any abort (stall, user Esc/Ctrl+C, parent), force-settle
          // if the tool promise does not resolve within the grace window.
          const onToolAbort = (): void => armGraceForceSettle();
          if (toolAc.signal.aborted) onToolAbort();
          else toolAc.signal.addEventListener("abort", onToolAbort, { once: true });
        });
      };

      try {
        result = await runToolWithForcedSettle();
        // User Esc/Ctrl+C: force-settle may resolve with a cancel result
        // instead of throwing — still end the turn as aborted.
        if (parentSignal.aborted && !stalledByWatchdog && !hardTimedOut) {
          const result: ToolResult = {
            ok: false,
            output: "Cancelled by user.",
            exitCode: 130,
          };
          emitToolResult(toolEventId, result, result.output);
          return {
            ok: false,
            call,
            result,
            contextOutput: result.output,
            aborted: true,
          };
        }
        if (liveBytes > 0) {
          writeToolOutput(toolEventId, "\n");
        }
        jobManager.updateJobStatus(
          jobId,
          result.ok ? "exited" : "failed",
          result.exitCode,
        );
      } catch (toolError) {
        jobManager.updateJobStatus(jobId, "failed", 1);
        if (isAbortError(toolError, toolAc.signal) || forceSettled) {
          if (parentSignal.aborted && !stalledByWatchdog && !hardTimedOut) {
            const result: ToolResult = {
              ok: false,
              output: "Cancelled by user.",
              exitCode: 130,
            };
            emitToolResult(toolEventId, result, result.output);
            return {
              ok: false,
              call,
              result,
              contextOutput: result.output,
              aborted: true,
            };
          }
          result = {
            ok: false,
            output: stalledByWatchdog
              ? `Tool timed out after ${TOOL_STALL_ABORT_MS / 1_000}s without output.`
              : hardTimedOut
                ? `Tool hard-timeout after ${hardSecs}s — cancelled.`
                : "Tool aborted before it could complete.",
            exitCode: stalledByWatchdog || hardTimedOut ? 124 : 130,
          };
        } else {
          const errMsg =
            toolError instanceof Error ? toolError.message : String(toolError);
          result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        if (hardTimer) clearTimeout(hardTimer);
        if (graceTimer) clearTimeout(graceTimer);
        engagementLease?.release();
        parentSignal.removeEventListener("abort", onParentAbort);
      }

      if (result.suppressedRepeat) {
        const contextOutput = result.output;
        const output = result.output.endsWith("\n")
          ? result.output
          : `${result.output}\n`;
        writeToolOutput(toolEventId, output, { replace: true });
        emitToolResult(toolEventId, result, contextOutput);
        options.onToolResult?.(call, result);
        // Record it as an observation-free success so the per-call guard can
        // stop an identical replay, while a real state change (new job status
        // or bytes) still produces a fresh stateKey and is allowed through.
        const suppressedProbeState = probeStateKey(call);
        loopGuard.recordAttempt(
          step,
          call.name,
          call.args,
          true,
          result.exitCode,
          "",
          suppressedProbeState ? { stateKey: suppressedProbeState } : undefined,
        );
        await auditLog("tool.result", {
          call,
          ok: result.ok,
          exitCode: result.exitCode,
          output: result.output.slice(0, 4_000),
          suppressedRepeat: true,
        });
        return {
          ok: result.ok,
          call,
          result,
          contextOutput,
          suppressedRepeat: true,
        };
      }

      if (
        (call.name === "shell.exec" || call.name === "shell.start") &&
        typeof call.args.command === "string" &&
        isScaffoldCreateCommand(call.args.command)
      ) {
        const cmd = call.args.command;
        const cwdArg =
          typeof call.args.cwd === "string" ? call.args.cwd : undefined;
        const out = result.output ?? "";
        // Prefer path reported by the scaffolder (handles quoted-cd mis-parse leftovers).
        const fromOutput = out.match(
          /Scaffolding project in\s+([^\n]+?)\s*\.{0,3}\s*$/im,
        )?.[1]?.trim().replace(/['"]/g, "");
        const fromScaffold =
          (fromOutput && fromOutput.startsWith("/")
            ? fromOutput
            : undefined) ??
          extractProjectRootFromScaffold(cmd, cwdArg);
        const cancelled = isScaffoldCancelledOutput(out);
        let materialized = scaffoldLooksMaterialized(fromScaffold);
        // One re-check: create-vite can report success before FS snapshot is visible.
        if (!materialized && fromScaffold) {
          materialized = scaffoldLooksMaterialized(fromScaffold);
        }
        const abortedMid =
          !result.ok &&
          (result.exitCode === 124 ||
            result.exitCode === 130 ||
            /timed out|aborted|Command aborted/i.test(out));
        const resumableMaterialized = Boolean(
          fromScaffold && materialized && (cancelled || abortedMid || !result.ok),
        );
        if (resumableMaterialized && fromScaffold) {
          setActiveProjectRootIfValid(fromScaffold, { force: true });
          await persistProjectRootOnPlan(fromScaffold);
          result = {
            ...result,
            ok: true,
            exitCode: 0,
            output:
              out +
              (out.endsWith("\n") ? "" : "\n") +
              `The scaffold reported ${cancelled ? "cancellation/refusal" : "interruption"}, but a usable project tree already exists at ${fromScaffold} ` +
              `(package/manifest present). Treat this as resumable: do NOT re-run the scaffolder. ` +
              `Inspect the existing files, finish any missing install, implement the requested feature, then run/verify.`,
          };
          writeNotice(
            "info",
            `project root → ${fromScaffold} (existing materialized scaffold — continue)`,
          );
        } else if (result.ok && cancelled && !materialized) {
          result = {
            ok: false,
            output:
              out +
              (out.endsWith("\n") ? "" : "\n") +
              `Scaffold FAILED: tool reported cancel/refuse. ` +
              (fromScaffold ? `Expected project at ${fromScaffold}. ` : "") +
              `If the folder already exists, CONTINUE it (do not re-scaffold). Otherwise use a new empty name or hand-write a minimal tree.`,
            exitCode:
              result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
          };
        } else if (result.ok && !materialized) {
          // Soft warn only when we truly see no tree — do not flip ok if output
          // clearly scaffolded (path may still resolve on next tool).
          const claimedScaffold = /Scaffolding project in\b/i.test(out);
          if (!claimedScaffold) {
            result = {
              ok: false,
              output:
                out +
                (out.endsWith("\n") ? "" : "\n") +
                `Scaffold FAILED: target project tree was not created. ` +
                (fromScaffold ? `Expected project at ${fromScaffold}. ` : "") +
                `If the folder already exists, CONTINUE it (do not re-scaffold). Otherwise use a new empty name or hand-write a minimal tree.`,
              exitCode:
                result.exitCode && result.exitCode !== 0 ? result.exitCode : 1,
            };
          } else if (fromScaffold) {
            setActiveProjectRootIfValid(fromScaffold, { force: true });
            await persistProjectRootOnPlan(fromScaffold);
            writeNotice(
              "info",
              `project root → ${fromScaffold} (scaffold output claimed success — continue)`,
            );
          }
        } else if (result.ok && fromScaffold && materialized) {
          setActiveProjectRootIfValid(fromScaffold, { force: true });
          await persistProjectRootOnPlan(fromScaffold);
          writeNotice("info", `project root → ${fromScaffold}`);
        }
      }

      if (delegation?.taskId && !result.backgroundJob) {
        // The delegation never became a durable job: settle its child instead of
        // Leaving a permanently yellow subtask behind.
        const delegationId = delegation.id;
        const settledState = result.ok ? "skipped" : "failed";
        const settlement = await mutatePlan(session.sessionId, (draft) => {
          const child = draft.tasks.find(
            (task) => task.delegationId === delegationId,
          );
          if (!child) return false;
          child.state = settledState;
          child.note = result.ok
            ? `delegation=${delegationId} ran in the foreground; no durable job was created`
            : `delegation=${delegationId} failed to launch`;
          return true;
        }).catch(() => undefined);
        if (settlement?.ok && settlement.plan) {
          pendingSessionStatePlan = settlement.plan;
          writePlanUpdate(settlement.plan);
        }
        delegation = undefined;
      }

      if (result.backgroundJob) {
        const durableJob = jobManager.getJob(result.backgroundJob.id);
        // Responder linkage is opt-in: only jobs launched with responder:true
        // become fire-and-forget plan subtasks that auto-wake on completion.
        // Plain background jobs stay pollable (shell.jobs/shell.tail) as before.
        if (durableJob?.responder) {
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        let linkedTaskId = delegation?.taskId;
        let linkedParentTaskId: string | undefined;
        let responderTaskId: string | undefined;
        let responderChildId: string | undefined;
        if (durableJob && livePlan) {
          const existing = livePlan.tasks.find(
            (task) => task.jobId === durableJob.id,
          );
          const parentTaskId = dispatchedTaskId && livePlan.tasks.some(
            (task) => task.id === dispatchedTaskId,
          )
            ? dispatchedTaskId
            : undefined;
          const terminalState =
            durableJob.status === "exited"
              ? "done"
              : durableJob.status === "failed" ||
                  durableJob.status === "killed" ||
                  durableJob.status === "lost"
                ? "failed"
                : "in_progress";
          const note =
            `job=${durableJob.id} pid=${durableJob.pid ?? "?"} status=${durableJob.status} ` +
            `artifact=${durableJob.stdoutArtifact}`;
          const responderTitle = `Responder · ${durableJob.name ?? durableJob.commandDisplay.slice(0, 96)}`;
          // Upsert the child by delegation/job identity
          // inside the transactional boundary. A concurrent settlement that
          // already turned the child green is therefore never reverted, and the
          // child is never written as the foreground parent.
          const upsert = await mutatePlan(session.sessionId, (draft) => {
            const target =
              (durableJob.delegationId
                ? draft.tasks.find(
                    (task) => task.delegationId === durableJob.delegationId,
                  )
                : undefined) ??
              draft.tasks.find((task) => task.jobId === durableJob.id);
            const child =
              target ??
              appendPlanTask(draft, {
                title: responderTitle,
                state: terminalState,
                note,
                dependencies: [],
                resourceLocks: [],
                parentTaskId,
                jobId: durableJob.id,
                processId: durableJob.pid,
                responderOwned: true,
                ...(durableJob.delegationId
                  ? { delegationId: durableJob.delegationId }
                  : {}),
              });
            // Never regress a child that process settlement already finished.
            const settledTerminal =
              child.state === "done" || child.state === "failed";
            if (!settledTerminal) {
              child.state = terminalState;
              child.note = note;
            }
            child.jobId = durableJob.id;
            child.processId = durableJob.pid;
            child.responderOwned = true;
            if (durableJob.delegationId) {
              child.delegationId = durableJob.delegationId;
            }
            if (parentTaskId) child.parentTaskId = parentTaskId;
            if (isPlanTerminal(draft)) {
              draft.status = isPlanSuccessful(draft) ? "completed" : "abandoned";
            } else if (draft.status !== "draft") {
              draft.status = "in_progress";
            }
            responderChildId = child.id;
            return true;
          }).catch(() => undefined);
          if (!upsert?.ok || !responderChildId) {
            writeNotice(
              "warn",
              `Responder job ${durableJob.id} started, but its plan subtask could not be persisted`,
            );
          } else {
            linkedTaskId = responderChildId;
            linkedParentTaskId = parentTaskId;
            responderTaskId = responderChildId;
            pendingSessionStatePlan = upsert.plan ?? livePlan;
            const rendered = upsert.plan ?? livePlan;
            writePlanUpdate(rendered);
          }
        }
        if (durableJob) {
          const linkedJob = jobManager.linkJob(durableJob.id, {
            ...(linkedTaskId ? { taskId: linkedTaskId } : {}),
            ...(linkedParentTaskId
              ? { parentTaskId: linkedParentTaskId }
              : {}),
            wakeOnCompletion: true,
            responder: true,
            monitor: {
              ...(durableJob.monitor ?? {}),
              toolName: call.name,
              toolEventId,
            },
          });
          if (!linkedJob) {
            writeNotice(
              "warn",
              `Responder job ${durableJob.id} started, but durable task linkage will be retried on completion`,
            );
          } else if (responderTaskId) {
            result = {
              ...result,
              output:
                `${result.output}\nResponder linked job ${durableJob.id} to subtask [${responderTaskId}]` +
                `${linkedParentTaskId ? ` under [${linkedParentTaskId}]` : ""}. ` +
                "This child subtask advances on its own from the real process result — do not mark, poll, or wait on it. " +
                "Mark your current launch step done and move to the next task now; do NOT shell.tail/shell.jobs/sleep to watch it. " +
                "The Responder delivers the completion into your context automatically when it is ready.",
            };
          }
        }
        }
      }

      const output = result.output.trim();
      // Always keep a full on-disk copy of tool output (any size) so the
      // pager never depends on a truncated in-memory preview.
      const savedOutputPath =
        result.outputPath ??
        (output ? await saveToolOutput(call, output) : undefined);
      const resultWithArtifact: ToolResult = {
        ...result,
        outputPath: savedOutputPath,
        truncated: result.truncated ?? Boolean(savedOutputPath),
      };

      if (savedOutputPath) {
        const storedJob = jobManager.getJob(jobId);
        if (storedJob) {
          storedJob.artifactPath = savedOutputPath;
        }
      }

      const contextOutput = formatToolContext(call, resultWithArtifact);
      emitToolResult(
        toolEventId,
        resultWithArtifact,
        contextOutput,
        savedOutputPath,
      );
      options.onToolResult?.(call, resultWithArtifact);
      await auditLog("tool.result", {
        call,
        ok: result.ok,
        exitCode: result.exitCode,
        output: result.output.slice(0, 4_000),
      });
      if (engagementGraph && engagementRecord) {
        if (result.backgroundJob) {
          const checkpointInput = {
            jobId: result.backgroundJob.id,
            status: result.backgroundJob.status,
            artifactPath: result.backgroundJob.artifactPath,
            offset: result.backgroundJob.nextOffset ?? 0,
            observation: result.output.slice(0, 16_000),
          };
          const reconciled = reconcileEngagementJob(engagementGraph, checkpointInput);
          if (!reconciled || reconciled.actionId !== engagementRecord.id) {
            recordEngagementCheckpoint(engagementGraph, {
              actionId: engagementRecord.id,
              ...checkpointInput,
            });
          }
        } else {
          finishEngagementAction(engagementGraph, engagementRecord.id, {
            ok: result.ok,
            observation: result.output.slice(0, 16_000),
            ...(savedOutputPath ? { artifactPath: savedOutputPath } : {}),
            scannerLead: call.name === "net.scan" || call.name.startsWith("pentest."),
          });
        }
        await saveEngagement(engagementGraph);
      }

      workLedger.recordToolCall(call, result.ok, savedOutputPath);

      const completedProbeState = probeStateKey(call);
      const newEvidence = recordToolEvidence(outcomeState, {
        tool: call.name,
        callId: toolEventId,
        ok: result.ok,
        ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
        output: result.output,
        ...(savedOutputPath ? { artifact: savedOutputPath } : {}),
        ...(dispatchedTaskId ? { taskId: dispatchedTaskId } : {}),
        ...(completedProbeState ? { stateKey: completedProbeState } : {}),
        args: call.args,
      });
      let hypothesisDelta = 0;
      if (!result.ok) {
        const before = outcomeState.failedHypotheses.length;
        recordFailedHypothesis(outcomeState, {
          signature: `${call.name}:${result.exitCode ?? 1}`,
          premise: `${call.name} with ${JSON.stringify(call.args).slice(0, 1_000)}`,
        });
        hypothesisDelta = outcomeState.failedHypotheses.length - before;
        retryDependenciesChanged = false;
        retryEnvironmentChanged = false;
        moveTurn("exploring", `${call.name} failed; revise the premise`);
      } else {
        const mutatesDependencies =
          /^(?:fs\.(?:write|writeMany|edit|replaceLines|append|delete)|pkg\.install)$/.test(call.name) ||
          ((call.name === "shell.exec" || call.name === "shell.start") &&
            /\b(?:install|mkdir|create|generate|build)\b/i.test(String(call.args.command ?? "")));
        retryDependenciesChanged ||= mutatesDependencies;
        retryEnvironmentChanged ||=
          call.name === "pkg.install" ||
          ((call.name === "shell.exec" || call.name === "shell.start") &&
            isPackageInstallCommand(String(call.args.command ?? "")));
      }
      // Protocol-repair placeholders are not live work — never let them
      // accumulate into a mid-turn pause (they used to look like failed tools).
      if (!isProtocolPlaceholderOutput(result.output)) {
        const governed = governProgress(governorState, "activity", {
          evidenceDelta: newEvidence.length,
          hypothesisDelta,
          repetitionScore:
            loopGuard.getAttemptCount(call.name, call.args) > 1 ? 1 : 0,
          policy: {
            resourceEnvelope: Math.max(12, maxSteps),
            // Coding builds get a much higher ceiling; never use the tight
            // default that stopped multi-file scaffolds after a handful of steps.
            emergencyCeiling: codingSession
              ? Math.max(200, maxSteps * 5)
              : Math.max(70, maxSteps * 3),
            reflectionAfterNoDelta: codingSession ? 5 : 3,
            pauseAfterNoDelta: codingSession ? 24 : 6,
            repetitionThreshold: 0.8,
          },
        });
        governorState = governed.state;
        if (governed.recommendation === "reflect") {
          deferredPostToolMessages.push({
            role: "system",
            content:
              `PROGRESS GOVERNOR: ${governed.reason}. Reassess the current premise and choose the next action that can produce criterion-linked evidence.` +
              (codingSession
                ? " Keep working — coding builds do not stop for a continue prompt."
                : ""),
          });
        }
      }
      await saveOutcomeState(outcomeState);

      loopGuard.recordAttempt(
        step,
        call.name,
        call.args,
        result.ok,
        result.exitCode,
        result.output,
        completedProbeState ? { stateKey: completedProbeState } : undefined,
      );

      // Evidence for verify-before-done: only successful real work counts.
      if (result.ok && isEvidenceWorkTool(call.name)) {
        const liveAfter = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        // Never credit whichever task happens to be open after execution: a
        // later task.update in the same batch may already have changed it.
        const creditId = dispatchedTaskId;
        const cmd =
          typeof call.args.command === "string" ? call.args.command : "";
        const signals: TaskWorkSignals = {};
        if (isFeatureImplementationCall(call)) signals.featureWrite = true;
        if (
          call.name === "fs.write" ||
          call.name === "fs.writeMany" ||
          call.name === "fs.edit" ||
          call.name === "fs.replaceLines" ||
          call.name === "fs.append"
        ) {
          signals.sourceWrite = true;
        }
        if (
          (call.name === "shell.exec" || call.name === "shell.start") &&
          isPackageInstallCommand(cmd)
        ) {
          signals.installOk = true;
        }
        if (
          (call.name === "shell.exec" || call.name === "shell.start") &&
          isScaffoldCreateCommand(cmd)
        ) {
          signals.scaffoldOk = true;
        }
        if (isDevServerCall(call)) signals.devServerStart = true;
        const out = result.output ?? "";
        if (
          (call.name === "shell.tail" || call.name === "shell.start") &&
          isServerReadyOutput(out)
        ) {
          signals.serverReady = true;
        }
        if (
          call.name === "shell.exec" &&
          isPortListeningOutput(cmd, out)
        ) {
          signals.portListening = true;
        }
        if (
          localHttpProbeIsSuccess(out) ||
          (sawLocalHttpProbe && !sawFailedLocalHttpProbe)
        ) {
          // Prefer explicit success parse on this result
          if (
            /\b(localhost|127\.0\.0\.1)\b/i.test(
              `${call.name} ${cmd} ${JSON.stringify(call.args)}`,
            )
          ) {
            if (localHttpProbeIsSuccess(out)) {
              signals.localHttpProbeOk = true;
            }
          }
        }
        // Remote/pentest evidence — never conflate with local app runtime
        if (isRemoteReconToolCall(call)) signals.remoteReconOk = true;
        if (isRemoteActiveTestCall(call)) signals.remoteActiveTestOk = true;
        // Always bank the success for later absorb (preflight / no open task).
        sessionLooseWork.push({
          toolName: call.name,
          ...(Object.keys(signals).length > 0 ? { signals } : {}),
        });
        taskWorkLedger = recordTaskWorkSuccess(
          taskWorkLedger,
          creditId,
          call.name,
          signals,
        );
        // If nothing was open, still try to attach to the next ready explore
        // task so "Check Node/npm" can complete without thrash.
        if ((!creditId || !taskWorkLedger || taskWorkLedger.taskId !== creditId) && liveAfter) {
          const ready = readyPlanTasks(liveAfter)[0];
          if (ready) {
            const absorbed = absorbLooseWorkIntoLedger(
              ledgerFromTaskEvidence(ready.id, ready.evidence),
              ready.id,
              ready.title,
              [{ toolName: call.name, signals }],
              { planKind: liveAfter.kind },
            );
            if (absorbed && absorbed.successWorkCount > 0) {
              const task = liveAfter.tasks.find((t) => t.id === ready.id);
              if (task) {
                task.evidence = taskEvidenceFromLedger(absorbed);
                if (
                  !taskWorkLedger ||
                  taskWorkLedger.taskId !== ready.id ||
                  taskWorkLedger.successWorkCount < absorbed.successWorkCount
                ) {
                  taskWorkLedger = absorbed;
                }
                await persistTaskEvidence(task.id, task.evidence);
              }
            }
          }
        }
        if (liveAfter && creditId && taskWorkLedger?.taskId === creditId) {
          const task = liveAfter.tasks.find((candidate) => candidate.id === creditId);
          if (task) {
            task.evidence = taskEvidenceFromLedger(taskWorkLedger);
            await persistTaskEvidence(task.id, task.evidence);
          }
        }
        // Do NOT refreshSessionState here. executeSingleTool often finishes
        // (especially in Promise.all parallel groups) *before* recordResult
        // appends role:tool rows. Upserting SESSION STATE between
        // assistant.toolCalls and those results breaks native tool protocol;
        // repairToolProtocol then drops the live bodies and injects
        // "No stored body" placeholders — models thrash re-running tools
        // that already succeeded in the UI. Refresh once after the batch.
        pendingSessionStatePlan = liveAfter ?? pendingSessionStatePlan;
      }


      if (!result.ok) {
        const reflection = loopGuard.getFailureReflection();
        if (reflection) {
          deferredPostToolMessages.push({ role: "system", content: reflection });
          const failCount = loopGuard.consecutiveFailureCount();
          writeNotice(
            "warn",
            `${failCount} consecutive failures — model evaluating approach`,
          );
        }
      }

      if (output) {
        // Authoritative FULL body — replace any live stream so the pager
        // never shows a truncated mid-run preview. Never cap for the UI.
        const fullChunk = output.endsWith("\n") ? output : `${output}\n`;
        writeToolOutput(toolEventId, fullChunk, { replace: true });
      }

      return { ok: result.ok, call, result, contextOutput };
    }


    // Align with /compact default: small recency + dense memory (not keepRecent=6 fat tails).
    const AUTO_COMPACT_KEEP_RECENT = 2;
    let lastCompactionMsgCount = 0;
    const compactionAttempts = new CompactionAttemptLedger();
    let activeCompactionId: string | undefined;
    /** E5: identical tool bodies within this turn → pointer instead of re-append. */
    const toolResultHashes = new Map<
      string,
      { toolName: string; count: number }
    >();
    /** E4: consecutive free-tier stream failures this turn. */
    let freeTierConsecutiveFailures = 0;
    let freeTierLargeContextWarned = false;
    // Surface the free-tier "failed N times / switch provider" advisory at most
    // once per turn — the recovery planner already narrates each retry, so
    // repeating this on every failure just adds noise.
    let freeTierAdvisoryShown = false;

    const summarizeForCompaction = async (
      summaryPrompt: string,
      stage?: CompactionSummaryStage,
    ): Promise<string> => {
      const streamFinalSummary = stage?.phase !== "map";
      const compactionId = streamFinalSummary ? activeCompactionId : undefined;
      const maxTokens =
        stage?.phase === "map"
          ? COMPACTION_MAP_MAX_COMPLETION_TOKENS
          : COMPACTION_MAX_COMPLETION_TOKENS;
      const sourceMessages = stage?.sourceMessages;
      const compactionTools = sourceMessages
        ? selectToolDefs(nativeToolsActive, useCompactSystemPrompt)
        : undefined;
      const request = {
        provider,
        model,
        messages: sourceMessages
          ? [
              ...sourceMessages,
              { role: "user" as const, content: summaryPrompt },
            ]
          : [
              { role: "system" as const, content: COMPACTION_SYSTEM_PROMPT },
              { role: "user" as const, content: summaryPrompt },
            ],
        temperature: 0.1,
        maxTokens,
        thinking: { enabled: false, effort: "none" as const },
        signal: options.signal,
        allowModelFallback: true,
        ...(compactionTools?.length
          ? {
              tools: compactionTools,
              toolChoice: "none" as const,
            }
          : {}),
      };
      const runAttempt = async (
        attemptRequest: typeof request,
        replace = false,
      ) => {
        if (compactionId && replace) {
          writeCompactionDelta(compactionId, "", true);
        }
        const parser = createThinkingStreamParser(
          (text) => {
            if (compactionId) writeCompactionDelta(compactionId, text);
          },
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
            messages: sourceMessages
              ? [
                  ...sourceMessages,
                  {
                    role: "user" as const,
                    content: buildCompactionRetryPrompt(
                      summaryPrompt,
                      retryReason,
                    ),
                  },
                ]
              : [
                  {
                    role: "system" as const,
                    content: `${COMPACTION_SYSTEM_PROMPT}\nReturn only a complete continuation-memory summary. Do not include analysis, reasoning, or <think> tags.`,
                  },
                  {
                    role: "user" as const,
                    content: buildCompactionRetryPrompt(
                      summaryPrompt,
                      retryReason,
                    ),
                  },
                ],
            temperature: 0,
            maxTokens,
            thinking: { enabled: false, effort: "none" as const },
            allowModelFallback: true,
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

    /**
     * Estimate the complete next model request, including attached native-tool
     * schemas. This must match the request-context accounting used by the UI
     * and audit trail: large schemas can otherwise push an actual request past
     * the compaction threshold while message-only accounting says it is safe.
     */
    const estimateNextRequestTokens = (
      contextMessages: readonly ChatMessage[],
    ): number => {
      const { native } = resolveNativeTools(provider, model);
      const nextTools = selectToolDefs(native, useCompactSystemPrompt);
      return buildContextBreakdown(contextMessages, nextTools).estimatedTotalTokens;
    };

    /**
     * Canonical state that must survive compaction verbatim. Built from the
     * plan store, outcome contract, responder ledger and mutation ledger — never
     * from the narrative summary.
     */
    async function buildTurnDurableEnvelope(): Promise<string | undefined> {
      const plan =
        (await loadPlan(session.sessionId).catch(() => undefined)) ?? undefined;
      const root = getActiveProjectRoot() ?? plan?.meta?.projectRoot;
      const consumed: string[] = [];
      for (const message of messages) {
        if (!isResponderResultLedgerMessage(message)) continue;
        for (const line of message.content.split("\n")) {
          const match = /notification=(\S+)/.exec(line);
          if (match?.[1]) consumed.push(match[1]);
        }
      }
      const unread = jobManager
        .getPendingNotifications(session.sessionId)
        .map((notification) => notification.id);
      const toEnvelopeJob = (job: BackgroundJob): EnvelopeJobState => ({
        id: job.id,
        status: job.status,
        command: job.commandDisplay || job.command,
        ...(job.taskId ? { taskId: job.taskId } : {}),
        ...(job.stdoutArtifact ? { artifact: job.stdoutArtifact } : {}),
      });
      const liveJobs = jobManager
        .getRunningJobs(session.sessionId)
        .map(toEnvelopeJob);
      const liveIds = new Set(liveJobs.map((job) => job.id));
      const finishedJobs = jobManager
        .getRecentJobs(12, session.sessionId)
        .filter((job) => !liveIds.has(job.id))
        .map(toEnvelopeJob);
      return buildDurableEnvelope({
        ...(plan ? { plan } : {}),
        outcome: outcomeState,
        ledger: workLedger,
        ...(root ? { projectRoot: root } : {}),
        ...(root
          ? { packageManager: plan?.meta?.packageManager ?? detectPackageManager(root) }
          : {}),
        responder: { unread, consumed: [...new Set(consumed)] },
        ...(liveJobs.length > 0 ? { liveJobs } : {}),
        ...(finishedJobs.length > 0 ? { finishedJobs } : {}),
      });
    }

    async function maybeAutoCompact(
      reason: string,
      force = false,
    ): Promise<void> {
      const beforeTokens = Math.max(
        estimateNextRequestTokens(messages),
        lastExactPromptTokens,
      );
      const contextLimitTokens = currentContextLimitTokens();
      const compactTrigger = autoCompactTriggerTokens(getReliabilityPolicy(), {
        provider,
        model,
        ...(contextLimitTokens !== undefined
          ? { contextLimitTokens }
          : {}),
      });
      if (!force && beforeTokens < compactTrigger) return;
      // Structural eligibility only: there must be closed history to summarize.
      if (messages.length <= AUTO_COMPACT_KEEP_RECENT + 2) return;
      const durableEnvelope = await buildTurnDurableEnvelope();
      const attemptKey = compactionAttemptKey({
        messages,
        provider,
        model,
        dialect: toolDialect,
        triggerTokens: compactTrigger,
        schemaHash: toolSchemaHash(selectToolDefs(nativeToolsActive, useCompactSystemPrompt)),
        ...(durableEnvelope ? { durableEnvelope } : {}),
      });
      if (!force && compactionAttempts.isSuppressed(attemptKey)) return;
      const compactionId = `compact-${randomUUID().slice(0, 12)}`;
      activeCompactionId = compactionId;
      writeCompactionStarted(compactionId, beforeTokens);
      try {
        const compactionTools = selectToolDefs(
          nativeToolsActive,
          useCompactSystemPrompt,
        );
        const compactionSchemaTokens = buildContextBreakdown(
          [],
          compactionTools,
        ).estimatedTotalTokens;
        const result = await compactMessagesWithSummary(
          messages,
          summarizeForCompaction,
          {
            budgetTokens: 0,
            keepRecent: AUTO_COMPACT_KEEP_RECENT,
            singlePassInputBudgetTokens: Math.max(
              0,
              compactionSinglePassInputBudget(
                contextLimitTokens ?? modelContextWindow(model, provider),
              ) - compactionSchemaTokens,
            ),
            ...(durableEnvelope ? { durableEnvelope } : {}),
          },
        );
        const summaryBody =
          result.messages.find((m) => isCompactionMemoryMessage(m))?.content ??
          "";
        if (
          !shouldApplyAutoCompact({
            summarized: result.summarized,
            summaryBody,
            beforeTokens: result.beforeTokens,
            afterTokens: result.afterTokens,
            afterMessages: result.messages,
          })
        ) {
          writeCompactionFailed(
            compactionId,
            "The generated summary was not accepted; the original context was retained.",
            beforeTokens,
          );
          return;
        }
        // otherwise the oversized request is sent anyway and corrective
        // compaction is suppressed as "already compacted".
        const candidateTokens = estimateNextRequestTokens(result.messages);
        if (!force && candidateTokens >= compactTrigger) {
          const dominant = describeDominantContextBlock(result.messages);
          compactionAttempts.recordFailure(attemptKey);
          await auditLog("agent.compact.overflow", {
            reason,
            candidateTokens,
            trigger: compactTrigger,
            dominant,
          });
          writeNotice(
            "warn",
            `context is still ~${candidateTokens.toLocaleString()} tokens after compaction (limit ~${compactTrigger.toLocaleString()}) — largest block: ${dominant}`,
          );
          writeCompactionFailed(
            compactionId,
            `Summary remained over the context limit; largest block: ${dominant}.`,
            beforeTokens,
          );
          return;
        }
        messages.splice(0, messages.length, ...result.messages);
        compactionAttempts.recordSuccess(attemptKey);
        loopGuard.resetReadOnly();
        lastExactPromptTokens = 0;
        // Token stats use the same complete request estimate as the trigger.
        const compactedTokens = estimateNextRequestTokens(messages);
        // Re-inject the live plan so the model keeps full plan awareness even
        // after older turns (which carried the plan context) were summarized.
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlan) {
          upsertPlanContextMessage(
            messages,
            planContextMessage(livePlan, session.planApproved.value),
          );
        }
        // Re-inject live SESSION STATE after compaction (older flags survive).
        refreshSessionState(livePlan);
        lastCompactionMsgCount = messages.length;
        // Final request count the model receives (may include re-injected plan).
        const afterTokens = estimateNextRequestTokens(messages);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: afterTokens,
          reason,
        });

        const insertedSummary =
          messages.find((m) => isCompactionMemoryMessage(m))?.content ?? "";
        const summaryText = insertedSummary.startsWith(
          `${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`,
        )
          ? insertedText(insertedSummary, `${PLAN_IMPLEMENT_MEMORY_PREFIX}\n\n`)
          : insertedSummary.startsWith(`${COMPACTION_MEMORY_PREFIX}\n\n`)
            ? insertedText(insertedSummary, `${COMPACTION_MEMORY_PREFIX}\n\n`)
            : insertedText(
                insertedSummary,
                insertedSummary.startsWith(PLAN_IMPLEMENT_MEMORY_PREFIX)
                  ? PLAN_IMPLEMENT_MEMORY_PREFIX
                  : COMPACTION_MEMORY_PREFIX,
              );
        // Report the final assembled request, including live plan and session
        // state reinjection, so the card and the next provider request agree.
        writeCompactionCompleted(compactionId, summaryText, beforeTokens, afterTokens);
        writeNotice(
          "info",
          `context auto-compacted to fit the window (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeCompactionFailed(
          compactionId,
          /aborted/i.test(message) ? "Compaction was cancelled." : message,
          beforeTokens,
        );
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("aborted"))
        ) {
          throw error;
        }
        compactionAttempts.recordFailure(attemptKey);
        await auditLog("agent.compact.failed", { reason: message });
      } finally {
        if (activeCompactionId === compactionId) activeCompactionId = undefined;
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {

      visibleCommitted = false;
      // `step` is the productive-step index (used for display + audit). It only
      // advances when the previous iteration actually executed a tool.
      step = productiveSteps;
      options.signal?.throwIfAborted();


      let call: ToolCall | undefined;
      let assistantText: {
        visible: string;
        thinkContent: string;
        hasThinking: boolean;
      };
      let canonicalAssistantVisible = "";
      let recoveredFromBareJson = false;

      if (pendingCalls.length > 0) {

        call = pendingCalls.shift()!;
        assistantText = { visible: "", thinkContent: "", hasThinking: false };
        const batchStatus = `  ↳ continuing batch (${pendingCalls.length} more queued)\n`;
        writeStatus(batchStatus);
      } else {

        await maybeAutoCompact("auto-token-budget");
        // Safe boundary: no assistant tool-call group is open here. Refresh the
        // durable Responder inbox immediately before every provider request so
        // completions arriving mid-turn are visible without corrupting native
        // tool protocol or forcing a separate busy-wait loop.
        const responderDelivery = refreshResponderInbox();

        const streamLabel =
          step === 0 ? "waiting for model" : `step ${step + 1}`;
        emit({ type: "status", text: streamLabel });
        let sawReasoning = false;
        let inThinking = false;
        let emittedThinkingStatus = false;
        let generatedTokens = 0;
        let accumulatedText = "";
        const callIds: string[] = [];
        let streamedCallsCount = 0;
        // A model can think silently for minutes. Without a heartbeat the UI
        // shows a frozen label and the turn looks hung, so surface the current
        // phase on a timer rather than only on token arrival.
        const streamPhase = (): string => {
          if (generatedTokens > 0 && !inThinking) {
            return "responding";
          }
          if (sawReasoning) return "thinking";
          return "waiting for model";
        };
        const heartbeat = setInterval(() => {
          emit({ type: "status", text: streamPhase() });
        }, 10_000);
        (heartbeat as unknown as { unref?: () => void }).unref?.();

        const deferredToolCalls: {
          eventId: string;
          call: ToolCall;
          rendered: string;
          shown: boolean;
        }[] = [];
        const streamedNativeCallNames = new Map<number, string>();
        const deltaParser = createThinkingStreamParser(
          (text) => emit({ type: "assistant-delta", text }),
          (text) => {
            if (!emittedThinkingStatus) {
              emittedThinkingStatus = true;
              emit({ type: "status", text: "thinking" });
            }
            emit({ type: "thinking-delta", text });
          },
        );
        let completion;
        let toolsAttached = false;
        try {
          // Re-resolve dialect each step so /model or sticky fallback apply.
          ({ dialect: toolDialect, native: nativeToolsActive } =
            resolveNativeTools(provider, model));
          if (messages[0]?.role === "system") {
            // Recompose only when content actually changes (hour-stable env clock
            // keeps the constitution prefix identical across steps, which helps
            // provider prompt caching and avoids needless object churn).
            const nextSystem = composeCurrentSystemPrompt(nativeToolsActive);
            if (messages[0].content !== nextSystem) {
              messages[0] = {
                role: "system",
                content: nextSystem,
              };
            }
          }
          const turnTools = selectToolDefs(
            nativeToolsActive,
            useCompactSystemPrompt,
          );
          toolsAttached = Boolean(turnTools?.length);
          const contextBreakdown = buildContextBreakdown(
            messages,
            toolsAttached ? turnTools : undefined,
          );
          emit({
            type: "context-estimate",
            estimatedTokens: contextBreakdown.estimatedTotalTokens,
            model,
          });
          // E4: advisory only — never blocks free-tier users.
          if (!freeTierLargeContextWarned) {
            const notices = freeTierGuardNotices({
              provider,
              estimatedInputTokens: contextBreakdown.estimatedTotalTokens,
              consecutiveFailures: freeTierConsecutiveFailures,
            });
            for (const notice of notices) {
              if (notice.includes("Large context")) {
                freeTierLargeContextWarned = true;
              }
              writeNotice("info", notice);
            }
          }
          const contextLimitTokens = currentContextLimitTokens();
          await auditLog("agent.turn", {
            provider,
            model,
            tool_protocol: toolsAttached ? "native" : "text",
            dialect: toolDialect,
            step,
            // Metadata-only composition metrics (no prompt/tool text).
            ...contextBreakdownAuditPayload(contextBreakdown),
            compactTriggerTokens: autoCompactTriggerTokens(
              getReliabilityPolicy(),
              {
                provider,
                model,
                ...(contextLimitTokens !== undefined
                  ? { contextLimitTokens }
                  : {}),
              },
            ),
            maxTokensBudget: resolveStepMaxTokens({
              nativeToolsActive,
              toolsAttached,
              recoveryNudge: retryWithoutThinking,
              truncationDepth: truncatedBudgetRounds,
            }),
          });
          // Resume / mid-turn abort can leave orphan tool rows or a user
          // "continue" before tool results. Heal first so multi-key retry and
          // history reloads don't hard-fail on protocol asserts.
          // Heal once per step if needed; silent (no toast) — placeholders are
          // ok=true so the model doesn't thrash on fake exit=130 failures.
          repairToolProtocol(messages);
          assertValidToolProtocol(messages);
          // E3: adaptive completion budget (still large enough for writes).
          stepMaxTokens = resolveStepMaxTokens({
            nativeToolsActive,
            toolsAttached,
            recoveryNudge: retryWithoutThinking,
            truncationDepth: truncatedBudgetRounds,
          });
          try {
          if (
            responderDelivery &&
            !jobManager.markDeliveryStarted(responderDelivery.id, session.sessionId)
          ) {
            jobManager.releaseResponderNotificationClaim(
              responderDelivery.id,
            );
            throw new Error(
              `failed to record responder delivery attempt ${responderDelivery.id}`,
            );
          }
          completion = await streamWithProvider(
            {
              provider,
              model,

              allowModelFallback,
              preferModelFallback,
              messages,

              // Sampling is provider/model policy (llm/sampling.ts).
              // Sending a fixed 0.2 here overrode it for every model.

              maxTokens: stepMaxTokens,
              signal: options.signal,
              thinking: retryWithoutThinking
                ? { ...config.thinking, enabled: false, effort: "low" }
                : config.thinking,
              ...(toolsAttached
                ? {
                  tools: turnTools,
                  toolChoice: "auto" as const,
                  parallelToolCalls: true,
                  onToolCallDelta: (delta) => {
                    if (!delta.name) return;
                    const name = fromWireName(delta.name) ?? delta.name;
                    streamedNativeCallNames.set(delta.index, name);
                    emit({
                      type: "status",
                      text:
                        delta.argumentsBytes && delta.argumentsBytes >= 4096
                          ? `${name} (${Math.round(delta.argumentsBytes / 1024)}KB args)`
                          : name,
                    });
                  },
                }
                : {}),
            },
            (token) => {
              deltaParser.push(token);
              generatedTokens += 1;
              accumulatedText += token;

              // Early UI cards from text fences only when native tools are off
              // (native args stream as structured deltas, not prose).
              if (!toolsAttached) {
                const parsedCalls = parseAllToolCalls(accumulatedText);
                if (parsedCalls.length > streamedCallsCount) {
                  while (streamedCallsCount < parsedCalls.length) {
                    const call = normalizeToolCall(
                      parsedCalls[streamedCallsCount]!,
                    );
                    const eventId = `tool-${++nextToolEventId}`;
                    callIds[streamedCallsCount] = eventId;
                    alreadyPrintedIds.add(eventId);
                    deferredToolCalls.push({
                      eventId,
                      call,
                      rendered: "",
                      shown: true,
                    });
                    writeToolCall(
                      eventId,
                      call,
                      styleToolChatter(
                        call,
                        chalk.cyan(`  ▶ ${call.name}`) +
                          chalk.gray(` ${formatToolArgs(call)}`),
                      ) + "\n",
                    );
                    emit({ type: "status", text: call.name });
                    streamedCallsCount += 1;
                  }
                }
              }

              if (
                !sawReasoning &&
                (token.includes(REASONING_OPEN) ||
                  /^\s*<think(?:ing)?\b/i.test(accumulatedText))
              ) {
                sawReasoning = true;
                inThinking = true;
                emit({ type: "status", text: "thinking" });
              }
              if (
                token.includes(REASONING_CLOSE) ||
                (inThinking && /<\/think(?:ing)?>/i.test(token))
              ) {
                inThinking = false;
                generatedTokens = 0;
              }
            },
            (status) => {
              writeStatus(status);
              // Toast only on key *switch* after a failure — never on sticky
              // "using" or retry countdown ticks (those stay in composer status).
              if (/^switching /i.test(status.trim())) {
                writeNotice("warn", status.trim());
              }
            },
          );
          freeTierConsecutiveFailures = 0;
          // Stream succeeded → the failure episode is over. Reset the recovery
          // budget and the one-shot fallback flag so a later, unrelated failure
          // starts fresh (and we never give up while making progress).
          resetStreamRecoveryState(recoveryState);
          allowModelFallback = false;
          preferModelFallback = false;
          lowYieldResumptions = 0;
          } catch (streamError) {
            // User cancelled (double-Esc) — never try to recover, just stop.
            if (options.signal?.aborted) throw streamError;

            // E4: track free-tier failures for advisory notices (never blocks).
            freeTierConsecutiveFailures += 1;
            if (!freeTierAdvisoryShown) {
              for (const notice of freeTierGuardNotices({
                provider,
                estimatedInputTokens: contextBreakdown.estimatedTotalTokens,
                consecutiveFailures: freeTierConsecutiveFailures,
              })) {
                if (notice.includes("Large context")) continue; // already shown above
                writeNotice("warn", notice);
                freeTierAdvisoryShown = true;
              }
            }

            // Robust recovery: a single flaky provider/model (empty admission,
            // connection glitch, capacity 5xx, rate limit, or an oversized
            // request) must not kill the turn. Classify the failure and take a
            // bounded, escalating recovery step — back off, compact, drop
            // thinking, or let the router fall back to another provider/model.
            // We only rethrow (stop the turn) in the worst case: every approach
            // for that failure class is exhausted or the total budget is spent.
            const failureKind = classifyStreamFailure(streamError);
            const partialStream =
              streamAlreadyEmitted(streamError) || accumulatedText.length > 0;
            const partial = rememberThinkingFromText(accumulatedText);
            const rawPartialVisible = partialStream
              ? textBeforeToolCall(
                  stripThinking(collapseRepeatedText(accumulatedText)).visible,
                )
              : "";
            const normalizedPartialVisible = trimExactContinuationOverlap(
              interruptedVisible,
              rawPartialVisible,
            );
            const partialVisible = normalizedPartialVisible.trim();
            // A route that drops after a handful of characters is not making
            // progress, however many times it is retried. Only a substantial
            // yield unlocks the generous resumption budget; anything less is
            // charged to the failure class and escalates to another route.
            const meaningfulProgress =
              partialStream &&
              isMeaningfulResumptionYield(
                normalizedPartialVisible.length + partial.thinkContent.length,
              );
            if (partialStream) {
              lowYieldResumptions = meaningfulProgress
                ? 0
                : lowYieldResumptions + 1;
            }
            const plan = planStreamRecovery({
              kind: failureKind,
              state: recoveryState,
              progressed: meaningfulProgress,
            });
            const terminalFailure = plan.action === "give-up";

            let continuationNudge = "";
            if (partialStream) {
              deltaParser.finish();
              const hasShownToolCall = deferredToolCalls.some(
                (entry) => entry.shown,
              );
              if (partialVisible) {
                // Finalizing here would close the streaming card and split one
                // answer across a card per interruption. Keep it open and let
                // the single commit below paint the stitched text; only a
                // terminal failure has to flush it now.
                if (terminalFailure) {
                  writeAssistantMessage(interruptedVisible + normalizedPartialVisible);
                } else {
                  visibleCommitted = true;
                }
                messages.push({
                  role: "assistant",
                  content: sanitizeAssistantText(partialVisible),
                });
                interruptedVisible += normalizedPartialVisible;
              } else if (terminalFailure) {
                emit({ type: "assistant-message", text: "" });
              }
              if (partial.hasThinking && !hasShownToolCall) {
                writeThinkingBlock(partial.thinkContent);
              }
              if (partial.hasThinking) {
                interruptedReasoning = appendInterruptedReasoning(
                  interruptedReasoning,
                  partial.thinkContent,
                );
              }
              for (const deferred of deferredToolCalls) {
                if (!deferred.shown || deferred.call.name === "…") continue;
                writeToolBlocked(
                  deferred.eventId,
                  deferred.call.name,
                  "Incomplete tool call discarded after the provider stream was interrupted.",
                );
              }
              continuationNudge = [
                partialVisible
                  ? "The provider stream was interrupted after partial output. Continue from the exact stopping point without repeating prior text. Any incomplete tool call was discarded and must be reissued in full."
                  : "The provider stream was interrupted before any answer was produced. Any incomplete tool call was discarded and must be reissued in full. Do not restart your analysis from the beginning.",
                interruptedReasoningBrief(interruptedReasoning),
              ]
                .filter((part): part is string => Boolean(part))
                .join("\n\n");
              const restartNotice = terminalFailure
                ? "partial response preserved before terminal provider failure"
                : lowYieldResumptions > 1
                  ? `route is dropping after almost no output (${lowYieldResumptions} in a row) — switching model`
                  : "partial response preserved — resuming from the interruption";
              writeNotice("warn", restartNotice);
            }

            if (terminalFailure) {
              throw streamError;
            }
            recordRecoveryAttempt(recoveryState, failureKind, meaningfulProgress);
            if (lowYieldResumptions > 1) {
              allowModelFallback = true;
              preferModelFallback = true;
            }

            if (plan.notice) {
              writeNotice("warn", plan.notice);
            }
            if (plan.disableThinking) retryWithoutThinking = true;
            if (plan.allowModelFallback) allowModelFallback = true;
            if (plan.preferModelFallback) preferModelFallback = true;
            if (plan.forceCompact) {
              await maybeAutoCompact(`stream-recovery:${failureKind}`, true);
            }
            const recoveryNudge = [continuationNudge, plan.nudge]
              .filter((part): part is string => Boolean(part))
              .join("\n\n");
            if (recoveryNudge) {
              messages.push(recoveryUserMessage(recoveryNudge));
            }
            if (plan.delayMs > 0) {
              emit({
                type: "status",
                text: `retrying in ${Math.ceil(plan.delayMs / 1000)}s (${failureKind})`,
              });
              await delay(plan.delayMs, options.signal);
            }
            continue;
          }
        } finally {
          clearInterval(heartbeat);
        }
        if (responderDelivery) {
          // The result text is now part of this turn, so consumption is durable.
          // A stream that aborted or threw above never reaches this point and the
          // receipt stays deliverable.
          if (!jobManager.markDelivered(responderDelivery.id, session.sessionId)) {
            jobManager.releaseResponderNotificationClaim(responderDelivery.id);
          }
        }
        provider = completion.provider;
        model = completion.model;
        if (completion.usage) {
          if (completion.usage.exact && completion.usage.promptTokens > 0) {
            lastExactPromptTokens = completion.usage.promptTokens;
          }
          emit({
            type: "token-usage",
            usage: completion.usage,
            model: completion.model,
            provider: completion.provider,
          });
          // Cache telemetry: without read/create counts there is no way to tell
          // whether the stable prefix is actually being reused.
          const cacheRead = completion.usage.cachedPromptTokens ?? 0;
          const cacheCreated = completion.usage.cacheCreationTokens ?? 0;
          if (cacheRead > 0 || cacheCreated > 0) {
            await auditLog("agent.prompt.cache", {
              provider: completion.provider,
              model: completion.model,
              promptTokens: completion.usage.promptTokens,
              cacheReadTokens: cacheRead,
              cacheCreationTokens: cacheCreated,
              hitRatio:
                completion.usage.promptTokens > 0
                  ? Number((cacheRead / completion.usage.promptTokens).toFixed(3))
                  : 0,
            });
          }
        }
        deltaParser.finish();
        // Sticky text-only may have flipped dialect during stream retry.
        ({ dialect: toolDialect, native: nativeToolsActive } =
          resolveNativeTools(provider, model));
        // toolsAttached may have been true for the request; if sticky
        // fallback dropped tools, treat as text mode for this turn's parse.
        const usedNativeProtocol = Boolean(completion.toolCalls?.length) ||
          (toolsAttached && !isTextOnlyModel(provider, model));

        const assistantTextResult = rememberThinkingFromText(completion.text);
        const continuedVisible = trimExactContinuationOverlap(
          interruptedVisible,
          assistantTextResult.visible,
        );
        canonicalAssistantVisible = interruptedVisible + continuedVisible;
        assistantText = {
          ...assistantTextResult,
          visible: continuedVisible,
        };
        const commitAssistantRetry = (historyText: string): void => {
          const hasShownToolCall = deferredToolCalls.some((entry) => entry.shown);
          if (!hasShownToolCall) {
            const displayText = textBeforeToolCall(
              collapseRepeatedText(canonicalAssistantVisible),
            ).trim();
            if (displayText) {
              writeAssistantMessage(displayText);
            } else {
              emit({ type: "assistant-message", text: "" });
            }
            if (assistantText.hasThinking) {
              emit({
                type: "thinking-block",
                content: assistantText.thinkContent,
              });
            }
          }
          pushAssistantHistory(historyText);
          interruptedVisible = "";
          interruptedReasoning = "";
          lowYieldResumptions = 0;
        };


        // Native-first: prefer structured toolCalls from the provider.
        let nativeToolCalls: NativeToolCall[] = completion.toolCalls ?? [];
        // Early UI cards: refresh args if stream deltas already opened cards;
        // otherwise create cards now (non-streaming / name-after-done providers).
        if (nativeToolCalls.length) {
          if (deferredToolCalls.length === 0) {
            for (let i = 0; i < nativeToolCalls.length; i += 1) {
              const tc = nativeToolCalls[i]!;
              const normalized = normalizeToolCall({
                name: tc.name,
                args: tc.args,
              });
              const eventId = `tool-${++nextToolEventId}`;
              callIds[i] = eventId;
              alreadyPrintedIds.add(eventId);
              deferredToolCalls.push({
                eventId,
                call: normalized,
                rendered: "",
                shown: false,
              });
            }
          } else {
            for (let i = 0; i < nativeToolCalls.length; i++) {
              const tc = nativeToolCalls[i]!;
              const normalized = normalizeToolCall({
                name: tc.name,
                args: tc.args,
              });
              const existing = deferredToolCalls[i];
              if (existing && existing.call.name !== "…") {
                callIds[i] = existing.eventId;
                existing.call = normalized;
              } else if (!existing || existing.call.name === "…") {
                const eventId =
                  existing?.eventId ?? `tool-${++nextToolEventId}`;
                callIds[i] = eventId;
                alreadyPrintedIds.add(eventId);
                const entry = {
                  eventId,
                  call: normalized,
                  rendered: "",
                  shown: existing?.shown ?? false,
                };
                if (existing) deferredToolCalls[i] = entry;
                else deferredToolCalls.push(entry);
              }
            }
          }
        }


        if (nativeToolCalls.length) {
          const first = nativeToolCalls[0]!;
          call = first.args?._parseError
            ? {
              name: first.name || "unknown",
              args: {
                __nativeParseError: true,
                _raw: first.args._raw,
              },
            }
            : normalizeToolCall({ name: first.name, args: first.args });
        } else {
          call = parseToolCall(assistantText.visible, {
            strict: getConfig().parserStrict,
          });
          if (!call && assistantText.hasThinking) {
            call = parseToolCall(assistantText.thinkContent, {
              strict: getConfig().parserStrict,
            });
            if (call) {
              writeNotice("info", "recovered tool call from thinking content");
            }
          }
        }


        if (looksLikePromptLeak(assistantText.visible)) {
          if (call || nativeToolCalls.length) {
            writeNotice(
              "warn",
              "suppressed tool call from apparent prompt leak",
            );
          }
          call = undefined;
          nativeToolCalls = [];
          deferredToolCalls.length = 0;
        }


        if (nativeToolCalls.length) {
          // Only salvage when args failed to parse (truncated JSON). A clean
          // parse with finish_reason=length is a complete tool call — execute it.
          const writeTc = nativeToolCalls.find((tc) => {
            const isWrite =
              tc.name === "fs.write" ||
              tc.name === "fs.append" ||
              tc.name === "fs.writeMany";
            return isWrite && Boolean(tc.args?._parseError);
          });
          if (writeTc) {
            const raw =
              writeTc.rawArguments ??
              (typeof writeTc.args?._raw === "string"
                ? String(writeTc.args._raw)
                : undefined);
            const salvaged = salvageTruncatedWriteFromNative(
              writeTc.name,
              raw,
            );
            if (salvaged) {
              truncatedToolRetries += 1;
              if (truncatedToolRetries <= 5) {
                try {
                  const writeResult = await applySalvagedWrite(salvaged);
                  if (writeResult.ok) {
                    const lineCount = salvaged.content.split("\n").length;
                    writeNotice(
                      "info",
                      `native tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
                    );
                    // Pair assistant tool_calls with synthetic results so the
                    // next turn is not orphaned, then nudge for append.
                    const salvageHistoryCalls = ensureUniqueToolCallIds(
                      nativeToolCalls,
                      toolCallIdsInHistory(messages),
                    );
                    const salvagedCallIndex = nativeToolCalls.indexOf(writeTc);
                    const salvagedCallId =
                      salvageHistoryCalls[salvagedCallIndex]?.id ?? writeTc.id;
                    appendAssistantWithTools(
                      messages,
                      assistantText.visible,
                      salvageHistoryCalls,
                      completion.reasoningBlock ??
                        (assistantText.hasThinking && assistantText.thinkContent
                          ? { text: assistantText.thinkContent }
                          : undefined),
                    );
                    for (const tc of salvageHistoryCalls) {
                      appendToolResult(
                        messages,
                        tc.id,
                        tc.id === salvagedCallId
                          ? `Tool ${tc.name} result (exit=0, ok=true):\nSalvaged partial write: ${lineCount} lines to ${salvaged.path}`
                          : `Tool ${tc.name} result (exit=1, ok=false):\nCancelled — sibling write was truncated and salvaged.`,
                        tc.name,
                        tc.id === salvagedCallId,
                      );
                    }
                    const priorBytes = writeResult.bytesOnDisk;
                    const salvagedToolName =
                      salvaged.operation === "append"
                        ? "fs.append"
                        : "fs.write";
                    const appendNudge = toolsAttached
                      ? `Your ${salvagedToolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE by calling fs.append now with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the remaining content not already on disk (prefer hundreds of lines per call). ` +
                      `Do not re-read the full file; do not re-send content already saved. Use the platform tool interface — no markdown fences.`
                      : `Your ${salvagedToolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE with ONE large fs.append of the remaining content:\n` +
                      '```tool\n{"name":"fs.append","args":{"path":' +
                      JSON.stringify(salvaged.path) +
                      ',"expectedPriorBytes":' +
                      priorBytes +
                      ',"content":"...ONLY the remaining content not already on disk..."}}\n```';
                    messages.push({
                      role: "user",
                      content: appendNudge,
                    });
                    nativeToolCalls = [];
                    call = undefined;
                    deferredToolCalls.length = 0;
                    continue;
                  }
                } catch {
                  // fall through to normal parse-error handling
                }
              }
            }
          }
        }


        if (nativeToolCalls.length) {
          const unparseable = nativeToolCalls.filter((tc) =>
            Boolean(tc.args?._parseError),
          );
          if (unparseable.length > 0) {
            malformedNativeArgsRounds += 1;
            if (malformedNativeArgsRounds >= 2) {
              const names = [...new Set(unparseable.map((tc) => tc.name))].join(", ");
              for (const entry of deferredToolCalls) {
                if (!entry.shown || entry.call.name === "…") continue;
                writeToolBlocked(
                  entry.eventId,
                  entry.call.name,
                  "Native tool arguments were unusable again; nothing ran. Reissue as a fenced tool block.",
                );
              }
              markTextOnlyModel(provider, model);
              writeNotice(
                "warn",
                "native tool arguments keep arriving unusable — switching this model to the text tool protocol",
              );
              commitAssistantRetry(assistantText.visible);
              messages.push(
                recoveryUserMessage(
                  `Your native ${names || "tool"} call arguments were not usable, so nothing ran. ` +
                    "Do not repeat that call. Emit exactly one complete fenced ```tool block with valid JSON arguments now.",
                ),
              );
              nativeToolCalls = [];
              call = undefined;
              deferredToolCalls.length = 0;
              continue;
            }
          } else {
            malformedNativeArgsRounds = 0;
          }
        }


        if (!canonicalAssistantVisible.trim() && !call) {
          const completionTokens = completion.usage?.completionTokens ?? 0;
          const hitOutputLimit =
            completion.finishReason === "length" ||
            (completionTokens > 0 && stepMaxTokens > 0 && completionTokens >= stepMaxTokens - 64);
          const truncatedRoundText = collapseRepeatedText(completion.text ?? "");
          if (hitOutputLimit && truncatedRoundText.trim() && truncatedBudgetRounds < 2) {
            truncatedBudgetRounds += 1;
            writeNotice(
              "warn",
              "response hit the output token limit — continuing from where it stopped",
            );
            messages.push({
              role: "assistant",
              content: sanitizeAssistantText(truncatedRoundText),
            });
            messages.push(
              recoveryUserMessage(
                "Your previous response was cut off by the output token limit before it completed. " +
                  "Continue directly from where it stopped — do not restart the analysis or repeat prior text. " +
                  "Finish briefly: emit the next tool call, or the final answer if the task is complete.",
              ),
            );
            continue;
          }
          const incompleteNativeStream =
            nativeToolCalls.length === 0 &&
            streamedNativeCallNames.size > 0;
          if (incompleteNativeStream) {
            const reason =
              "The provider began this native tool call but never completed it. Nothing ran; reissue a complete call.";
            for (const deferred of deferredToolCalls) {
              if (!deferred.shown || deferred.call.name === "…") continue;
              writeToolBlocked(deferred.eventId, deferred.call.name, reason);
            }
            markTextOnlyModel(provider, model);
            writeNotice(
              "warn",
              "provider abandoned a native tool call — switching this model to the text tool protocol",
            );
          }
          emptyVisibleRetries += 1;
          if (emptyVisibleRetries <= 3) {
            if (assistantText.hasThinking) {
              writeNotice(
                "warn",
                "model produced only thinking — nudging it to take action",
              );
            } else {
              writeNotice(
                "warn",
                "model returned an empty response — nudging it to answer",
              );
            }
            if (assistantText.hasThinking) retryWithoutThinking = true;
            commitAssistantRetry(assistantText.visible);
            // Keep nudges SHORT — cheap models lose the key instruction in long text.
            const buildNudge =
              incompleteNativeStream
                ? "Your native tool call was incomplete, so nothing ran. Use exactly one complete fenced ```tool block now; do not repeat the incomplete native call."
                : isPlanMode && !activePlan
                  ? toolsAttached
                    ? "No visible output. In plan mode: gather context or call plan.create when ready (do not only describe the plan)."
                    : "No visible output. In plan mode: emit a ```tool block for research/recon or plan.create. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response."
                  : toolsAttached
                    ? "No visible output. " + toolNudge(true)
                    : "No visible output. Emit a ```tool block or give your final answer. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response.";
            messages.push(recoveryUserMessage(buildNudge));
            continue;
          }

          writeNotice(
            "warn",
            "model returned an empty response after retries — no answer produced",
          );
          return finishTurn("Model returned an empty response after retries.", step + 1);
        } else {
          // Reset the counter on any successful visible output or recovered call.
          emptyVisibleRetries = 0;
          truncatedBudgetRounds = 0;
          retryWithoutThinking = false;
        }


        let bareArgsOnly = false;
        recoveredFromBareJson = false;
        if (!call) {
          const bare = recognizeBareToolJson(assistantText.visible);
          if (bare?.call) {
            call = bare.call;
            recoveredFromBareJson = true;
            writeNotice(
              "info",
              "recovered an unfenced tool call from bare JSON",
            );
          } else if (bare?.argsOnly) {
            bareArgsOnly = true;
          }
        }
        // Also check thinking content for bare JSON calls.
        if (!call && assistantText.hasThinking) {
          const bareThink = recognizeBareToolJson(assistantText.thinkContent);
          if (bareThink?.call) {
            call = bareThink.call;
            recoveredFromBareJson = true;
            writeNotice(
              "info",
              "recovered an unfenced tool call from thinking content",
            );
          } else if (bareThink?.argsOnly) {
            bareArgsOnly = true;
          }
        }
        if (!call) {
          consecutiveModelOnlyRounds += 1;
          if (bareArgsOnly) {
            bareToolJsonRetries += 1;
            if (bareToolJsonRetries <= 3) {
              writeNotice(
                "warn",
                toolsAttached
                  ? "tool call missing its name — asking the model to call a tool properly"
                  : "tool call missing its name/fence — asking the model to re-emit a proper ```tool block",
              );
              commitAssistantRetry(assistantText.visible);
              messages.push(
                recoveryUserMessage(
                  isPlanMode && !activePlan
                    ? toolsAttached
                      ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
                      "In plan mode: call plan.create (or research tools) via the platform tool interface."
                      : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                      "In plan mode, call plan.create with a proper ```tool block when ready, e.g.:\n" +
                      '```tool\n{"name":"plan.create","args":{"goal":"…","detail":"…","tasks":["…"],"kind":"coding"}}\n```'
                    : toolsAttached
                      ? "Your previous message was a bare JSON args object with no tool name, so NOTHING ran. " +
                      toolNudge(true) +
                      " Include the tool name and full args via the platform tool interface — do not use markdown fences."
                      : "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                      "Reply with ONLY a fenced ```tool block of the form " +
                      '`{"name": "<tool>", "args": { ... }}`. For example, to read a PDF:\n' +
                      '```tool\n{"name":"pdf.read","args":{"path":"/abs/file.pdf"}}\n```\n' +
                      "Choose the correct tool name for the task and include those args.",
                ),
              );
              continue;
            }
            // Exhausted retries — fall through to the normal answer path.
          }

          if (
            /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>|<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b|<[|｜]+tool[_▁](?:calls?[_▁]begin|sep)[|｜]+>/i.test(
              assistantText.visible,
            )
          ) {
            writeNotice(
              "warn",
              "tool call was malformed or cut off — asking the model to retry in JSON form",
            );
            commitAssistantRetry(assistantText.visible);
            messages.push(
              recoveryUserMessage(
                toolsAttached
                  ? "Your previous tool call was malformed or truncated. " +
                  toolNudge(true) +
                  " Pass valid JSON arguments via the platform tool interface — do not use fence or sentinel markers."
                  : "Your previous tool call was malformed or truncated. " +
                  "Reply with ONLY a fenced ```tool block containing valid JSON " +
                  'of the form `{"name": "<tool>", "args": { ... }}`. ' +
                  "Do not use <|tool_call_begin|> markers.",
              ),
            );
            continue;
          }

          if (looksLikeTruncatedToolCall(assistantText.visible)) {
            truncatedToolRetries += 1;


            const salvaged = salvageTruncatedWrite(assistantText.visible);

            if (salvaged && truncatedToolRetries <= 5) {
              // Write the salvaged partial content through the normal
              // authorization path (classifier + confirmation + receipt).
              try {
                const writeResult = await applySalvagedWrite(salvaged);
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
                  );
                  commitAssistantRetry(
                    stripThinking(assistantText.visible).visible,
                  );
                  const priorBytes = writeResult.bytesOnDisk;
                  const salvagedToolName =
                    salvaged.operation === "append" ? "fs.append" : "fs.write";
                  messages.push({
                    role: "user",
                    content: toolsAttached
                      ? `Your ${salvagedToolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE by calling fs.append now with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the remaining content (prefer large chunks). Use the platform tool interface — no markdown fences.`
                      : `Your ${salvagedToolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
                      `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n` +
                      `CONTINUE with ONE large fs.append of the remaining content (prefer hundreds of lines per call — do NOT use tiny ~100-line chunks):\n` +
                      '```tool\n{"name":"fs.append","args":{"path":' +
                      JSON.stringify(salvaged.path) +
                      ',"expectedPriorBytes":' +
                      priorBytes +
                      ',"content":"...ONLY the remaining content not already on disk..."}}\n```\n' +
                      `expectedPriorBytes must match the receipt so append cannot double-write. ` +
                      `Do NOT re-read the full file; do NOT re-send content already saved.`,
                  });
                  continue;
                }
              } catch {
                // Salvage failed — fall through to standard retry
              }
            }

            if (truncatedToolRetries <= 3) {
              writeNotice(
                "warn",
                "tool call was cut off (output too long) — asking the model to retry safely",
              );
              commitAssistantRetry(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content: toolsAttached
                  ? "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Prefer ONE complete fs.write when it fits. If the file is too large: (1) fs.write the first large section, " +
                  "(2) fs.append the rest with expectedPriorBytes from the write receipt, (3) repeat with large chunks. " +
                  "Keep reasoning SHORT and call the tool via the platform interface. Do NOT claim a file was written until a tool call succeeds."
                  : "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Prefer ONE complete fs.write when it fits (~32k output tokens is a lot of file content if reasoning stays short). " +
                  "If the file is too large for one call:\n" +
                  "1. fs.write the first large section (as much as fits — hundreds+ of lines)\n" +
                  "2. fs.append the rest with expectedPriorBytes from the write receipt\n" +
                  "3. Repeat append only if still incomplete — large chunks, not ~100-line drips\n" +
                  "Keep reasoning SHORT — emit the ```tool block early. Do NOT claim a file was written until a tool call succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through so we don't loop forever, but the
            // user at least sees the (broken) output and the stop notice.
          }

          const hasFencedCallShape =
            countToolFences(assistantText.visible) > 0 &&
            /```tool\s*\n[\s\S]*?"(?:name|args)"\s*:/i.test(
              assistantText.visible,
            );
          if (hasFencedCallShape) {
            // Before treating as a generic malformed fence, check if this is
            // actually a truncated write call that should be salvaged.
            const salvaged = salvageTruncatedWrite(assistantText.visible);
            if (salvaged) {
              try {
                const writeResult = await applySalvagedWrite(salvaged);
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}`,
                  );
                  commitAssistantRetry(
                    stripThinking(assistantText.visible).visible,
                  );
                  messages.push({
                    role: "user",
                    content:
                      `The system extracted and wrote ${lineCount} lines to ${salvaged.path} from your malformed tool call. ` +
                      `The file content ends at: "${salvaged.lastLine}"\n\n` +
                      `If the file is complete, proceed with the next step. ` +
                      `If more content is needed, use one large fs.append with expectedPriorBytes from the write receipt (not tiny chunks).`,
                  });
                  continue;
                }
              } catch {
                // Salvage failed — fall through to standard malformed retry
              }
            }

            malformedFenceRetries += 1;
            if (malformedFenceRetries <= 3) {
              writeNotice(
                "warn",
                "tool block present but its JSON didn't parse — asking the model to re-emit valid JSON",
              );
              commitAssistantRetry(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content: toolsAttached
                  ? "Your previous tool call JSON was INVALID, so NOTHING ran. " +
                  "Common causes: unescaped newlines/quotes, unbalanced braces, or content too large. " +
                  toolNudge(true) +
                  " Prefer ONE complete fs.write when it fits; if cut off, continue with large fs.append + expectedPriorBytes. " +
                  "Do NOT claim any file was written until a tool call actually succeeds."
                  : "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
                  "Common causes: unescaped newlines or quotes inside a string value, an extra or missing `}` / `]`, or content too large for the output window. " +
                  'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
                  "IMPORTANT: Prefer ONE complete fs.write when it fits. Keep reasoning SHORT. " +
                  "Only if the output window cuts you off, continue with large fs.append chunks + expectedPriorBytes. " +
                  "Do NOT claim any file was written until a tool call actually succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through to the normal path.
          }

          const displayCleaned = collapseRepeatedText(
            stripSentinelTokens(assistantText.visible),
          );
          const cleaned = collapseRepeatedText(
            stripSentinelTokens(canonicalAssistantVisible),
          );

          const narratedAction = looksLikeActionNarration(cleaned);
          const narratedWebAction = looksLikeWebActionNarration(cleaned);

          const livePlanAtCompletion = await loadPlan(session.sessionId).catch(
            () => undefined,
          );
          const planStatusAtCompletion =
            livePlanAtCompletion?.status ?? activePlan?.status;
          const completedPlanDuringThisTurn =
            activePlan?.status !== "completed" &&
            planStatusAtCompletion === "completed";
          const planHasOpenWorkNow = planHasOpenWork(planStatusAtCompletion);

          const userExpectsWork =
            (planHasOpenWorkNow && session.planApproved.value) ||
            (!informationalQuery &&
              !idleOrSocialPrompt &&
              (buildLikeTurn || pentestLikeTurn));

          const unreadResponderResults =
            unreadResponderNotificationIds.size > 0;
          const wantsAction =
            !completedPlanDuringThisTurn &&
            !idleOrSocialPrompt &&
            (userExpectsWork ||
              (narratedAction && !informationalQuery) ||
              (narratedWebAction && !informationalQuery));
          if (
            (wantsAction || unreadResponderResults) &&
            toolsAttached &&
            consecutiveModelOnlyRounds === 2
          ) {
            markTextOnlyModel(provider, model);
            commitAssistantRetry(assistantText.visible);
            writeNotice(
              "warn",
              "model repeatedly returned prose instead of a native tool call — switching this model to the text tool protocol",
            );
            messages.push(
              recoveryUserMessage(
                "Native tool calling did not produce an executable call. Continue now with exactly one complete fenced ```tool block. Do not repeat the prior narration.",
              ),
            );
            continue;
          }
          if (
            (wantsAction || unreadResponderResults) &&
            consecutiveModelOnlyRounds >= 6
          ) {
            commitAssistantRetry(assistantText.visible);
            const stalledMessage =
              "Stopped a repeated model-only retry cycle after the model returned no executable tool call. Completed work and transcript output were preserved.";
            writeAssistantMessage(stalledMessage);
            const remainingCriteria = livePlanAtCompletion
              ? foregroundRemaining(livePlanAtCompletion).map(
                  (task) => `[${task.id}] ${task.title}`,
                )
              : [];
            if (unreadResponderResults) {
              remainingCriteria.push(
                "Analyze and acknowledge each delivered Responder result.",
              );
            }
            if (remainingCriteria.length === 0) {
              remainingCriteria.push(
                "Continue the unfinished work with an executable tool call.",
              );
            }
            outcomeState.outcome.status = "partial";
            await saveOutcomeState(outcomeState);
            moveTurn("partial", "repeated model-only responses");
            return finishTurn(
              stalledMessage,
              productiveSteps,
              "partial",
              remainingCriteria,
              "The model returned six consecutive responses without executing a tool.",
            );
          }
          if (unreadResponderResults) {
            const unread = [...unreadResponderNotificationIds];
            commitAssistantRetry(assistantText.visible);
            messages.push(
              recoveryUserMessage(
                `You have ${unread.length} delivered Responder result(s) that remain unread: ${unread.join(", ")}. ` +
                  "If analysis is incomplete, call only the bounded evidence tool needed now. If each result has been analyzed and is satisfactory, you MUST call job.read with its jobId or exact notificationId before giving a final response. job.read does not require an active plan; do not create or update a plan merely to acknowledge a result.",
              ),
            );
            continue;
          }
          const deferResponderReport = session.planApproved.value
            ? shouldYieldForDeclaredResponderDependency(
                livePlanAtCompletion,
                jobManager.getRunningJobs(session.sessionId),
                jobManager.getPendingNotifications(session.sessionId),
                responderWakeNotificationId,
              )
            : false;
          const finalizeRecovery = chooseFinalizeRecovery({
            cleaned,
            recovery,
            toolsAttached,
            productiveSteps,
            planApproved: session.planApproved.value,
            planHasOpenWork: planHasOpenWorkNow,
            activePlanExists: Boolean(activePlan),
            wantsAction,
            narratedAction,
            narratedWebAction,
            isPlanMode,
            buildLikeTurn,
            pentestLikeTurn,
            buildLike,
            pentestLike,
            pentestSession,
            informationalQuery,
            idleOrSocialPrompt,
            sawPlanCreateOk,
            sawFeatureImplWrite,
            sawScaffoldOk,
            sawLocalAppMaterialWork,
            sawServerStart,
            sawServerTail,
            sawLocalHttpProbe,
            sawFailedLocalHttpProbe,
            sawActivePentestTest,
            sawSuccessfulMutation,
            featureAppAsk,
            projectRoot: getActiveProjectRoot(),
            plan: livePlanAtCompletion
              ? {
                  kind: livePlanAtCompletion.kind,
                  hasVerifiedRuntime:
                    planHasVerifiedRuntime(livePlanAtCompletion),
                  tasks: livePlanAtCompletion.tasks,
                }
              : undefined,
            deferResponderReport,
          });
          if (finalizeRecovery) {
            consumeBudget(recovery, finalizeRecovery.budgetKey);
            commitAssistantRetry(assistantText.visible);
            messages.push(recoveryUserMessage(finalizeRecovery.message));
            continue;
          }
          let outcomeStatus: TurnOutcomeStatus = "succeeded";
          const remainingCriteria: string[] = [];
          if (session.planApproved.value) {
            const livePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            // Foreground work decides the turn outcome. Responder children run
            // concurrently by design and are reported separately.
            const unfinished = livePlan ? foregroundRemaining(livePlan) : [];
            const failedTasks =
              livePlan?.tasks.filter(
                (task) => !task.responderOwned && task.state === "failed",
              ) ?? [];
            remainingCriteria.push(
              ...unfinished.map((task) => `[${task.id}] ${task.title}`),
              ...failedTasks.map((task) => `[${task.id}] retry failed task: ${task.title}`),
            );
            const openResponderChildren = livePlan
              ? responderOpenTasks(livePlan)
              : [];
            if (openResponderChildren.length > 0) {
              remainingCriteria.push(
                ...openResponderChildren.map(
                  (task) =>
                    `[${task.id}] responder result awaiting analysis: ${task.title}`,
                ),
              );
            }
            if (failedTasks.length > 0) outcomeStatus = "failed";
            else if (unfinished.length > 0) outcomeStatus = "partial";
          }
          recordAnswerEvidence(outcomeState, cleaned);
          outcomeState.outcome.status = deriveOutcomeStatus(
            outcomeState.outcome,
            outcomeState.evidence,
          );
          await saveOutcomeState(outcomeState);
          const unsupportedCriteria = outcomeState.outcome.criteria.filter(
            (criterion) =>
              criterion.required &&
              !validateCriterionEvidence(criterion, outcomeState.evidence).ok,
          );
          if (unsupportedCriteria.length > 0 && outcomeStatus === "succeeded") {
            outcomeStatus = "partial";
          }
          remainingCriteria.push(
            ...unsupportedCriteria
              .map((criterion) => criterion.statement)
              .filter((statement) => !remainingCriteria.includes(statement)),
          );
          moveTurn("verifying", "evaluating current criterion-linked evidence");
          moveTurn(outcomeStatus, `turn completed with ${outcomeStatus} evidence status`);
          await auditLog("agent.final", {
            provider,
            model,
            steps: step + 1,
            outcomeStatus,
            remainingCriteria,
          });
          lastAnswer = cleaned;
          return finishTurn(
            lastAnswer,
            step + 1,
            outcomeStatus,
            remainingCriteria,
            outcomeStatus === "failed"
              ? "One or more required plan tasks failed."
              : outcomeStatus === "partial"
                ? "Required outcome criteria remain unsupported by current evidence."
                : undefined,
            displayCleaned,
          );
        }

        // A valid primary tool call exists for this fresh model turn. Show any
        // prose / thinking that preceded it, record the assistant message ONCE.
        const beforeTool = recoveredFromBareJson
          ? ""
          : nativeToolCalls.length
            ? assistantText.visible.trim()
            : textBeforeToolCall(assistantText.visible);
        if (beforeTool) {
          writeAssistantMessage(beforeTool);
        } else {
          emit({ type: "assistant-message", text: "" });
        }
        interruptedVisible = "";
        interruptedReasoning = "";
        lowYieldResumptions = 0;

        type BoundCall = {
          index: number;
          id: string;
          call: ToolCall;
          native: NativeToolCall;
        };
        let bound: BoundCall[] = [];
        if (nativeToolCalls.length) {
          bound = nativeToolCalls.map((tc, index) => {
            const call = tc.args?._parseError
              ? {
                name: tc.name || "unknown",
                args: {
                  __nativeParseError: true,
                  _raw: tc.args._raw,
                },
              }
              : normalizeToolCall({ name: tc.name, args: tc.args });
            return { index, id: tc.id, call, native: tc };
          });
        } else {
          let parsed = parseAllToolCalls(
            assistantText.visible || assistantText.thinkContent,
          );
          if (parsed.length === 0 && call) parsed = [call];
          bound = parsed.map((rawCall, index) => {
            const call = normalizeToolCall(rawCall);
            const id = syntheticToolCallId(index);
            return {
              index,
              id,
              call,
              native: { id, name: call.name, args: call.args },
            };
          });
        }

        /** Subset that will actually run this turn (defer/omit rest). */
        let toRun = bound;
        let activeDeferredToolCalls = deferredToolCalls;
        let deferReason =
          "Cancelled — not executed this turn (deferred or omitted).";


        const planCallIndex = bound.findIndex(
          (b) => b.call.name === "plan.create",
        );
        if (planCallIndex > 0) {
          const deferredCount = bound.length - planCallIndex;
          toRun = bound.slice(0, planCallIndex);
          activeDeferredToolCalls = deferredToolCalls.slice(0, planCallIndex);
          deferReason =
            "Deferred — plan.create must wait until reconnaissance results exist.";
          writeNotice(
            "info",
            "deferring plan.create until reconnaissance results are available",
          );
          messages.push({
            role: "system",
            content:
              `The prior response included plan.create before its reconnaissance results existed. ` +
              `Only the ${toRun.length} gathering call(s) before it were run; ${deferredCount} plan/follow-on call(s) were not run. ` +
              "Now analyse the tool results. If a plan is appropriate, emit exactly one standalone plan.create tool call based only on those results. Do not include any other tool calls in that response.",
          });
        } else if (planCallIndex === 0 && bound.length > 1) {
          const deferredCount = bound.length - 1;
          toRun = bound.slice(0, 1);
          activeDeferredToolCalls = deferredToolCalls.slice(0, 1);
          deferReason =
            "Deferred — waiting for plan approval before follow-on tools.";
          writeNotice(
            "info",
            "creating the plan now; deferring follow-on calls until it is approved",
          );
          messages.push({
            role: "system",
            content:
              `You emitted plan.create alongside ${deferredCount} follow-on call(s). Only plan.create was run; ` +
              `the follow-on call(s) were not. Wait for the plan to be reviewed, then proceed task by task.`,
          });
        }

        // Preserve model/document order. In particular, never move a later
        // in_progress transition ahead of the preceding work or done receipt;
        // doing so inverts dependency order and desynchronizes the task pane.

        // Re-id empty/duplicate native ids BEFORE building toRun/history so
        // assistant toolCalls and role:tool results always share the same id.
        // Mismatched ids make results look orphaned → repair injects placeholders
        // → model thrash-retries tools that already succeeded in the UI.
        const historyNativeCalls = ensureUniqueToolCallIds(
          bound.map((b) => b.native),
          toolCallIdsInHistory(messages),
        );
        for (let i = 0; i < bound.length; i++) {
          const fixed = historyNativeCalls[i]!;
          bound[i] = {
            ...bound[i]!,
            id: fixed.id,
            native: fixed,
          };
        }
        // Re-bind toRun to the rewritten bound entries (by original call identity).
        toRun = toRun.map((old) => {
          const match = bound.find((b) => b.call === old.call);
          return match ?? old;
        });
        // Re-index toRun positions for UI callIds[] (0..n-1 this turn).
        toRun = toRun.map((b, index) => ({ ...b, index }));
        const allCalls = toRun.map((b) => b.call);
        const actionSequenceCalls = bound.map((entry) => {
          const candidate = entry.call;
          const stateKey = probeStateKey(candidate);
          return {
            name: candidate.name,
            args: candidate.args,
            ...(stateKey ? { stateKey } : {}),
          };
        });
        /** Stable call→Bound map (object identity; no indexOf for result ids). */
        const callToBound = new Map<ToolCall, BoundCall>(
          toRun.map((b) => [b.call, b]),
        );
        const runIds = new Set(toRun.map((b) => b.id));
        const sequenceDecision = loopGuard.observeActionSequence(actionSequenceCalls);

        if (sequenceDecision.suppress) {
          const reason = sequenceDecision.terminal
            ? "The model repeated the same action sequence after it was already suppressed. No commands were run again."
            : sequenceDecision.oscillation
              ? "This exact action sequence already completed earlier this turn (the agent is oscillating back to finished work). No commands were run again; every one of these results is already in context — synthesize them and either advance to a genuinely new action or finish."
              : "The same action sequence already ran in the previous model round. No commands were run again; reuse the existing results and choose a materially different next action or finish.";
          writeNotice("warn", reason);
          const suppressedResults = bound.map((b) => {
            const duplicate = runIds.has(b.id);
            const priorObservation = duplicate
              ? loopGuard.getPriorObservation(b.call.name, b.call.args)
              : undefined;
            const resultReason = duplicate
              ? reason +
                (priorObservation
                  ? `\n\nPrior successful result for ${b.call.name}:\n${priorObservation}`
                  : "")
              : deferReason;
            const result: ToolResult = {
              ok: duplicate,
              output: resultReason,
              exitCode: duplicate ? 0 : 130,
              ...(duplicate ? { suppressedRepeat: true } : {}),
            };
            return { b, resultReason, result };
          });
          // Sequence suppression happens before the normal queued-card flush.
          // Complete every card explicitly so streamed queued calls never turn
          // into empty "done" rows when the repeated sequence is skipped.
          for (const { b, resultReason, result } of suppressedResults) {
            const queued = deferredToolCalls[b.index];
            const eventId = queued?.eventId ?? `tool-${++nextToolEventId}`;
            writeToolCall(
              eventId,
              b.call,
              styleToolChatter(
                b.call,
                chalk.cyan(`  ▶ ${b.call.name}`) +
                  chalk.gray(` ${formatToolArgs(b.call)}`),
              ) + "\n",
            );
            alreadyPrintedIds.add(eventId);
            emit({ type: "tool-start", id: eventId });
            const output = resultReason.endsWith("\n")
              ? resultReason
              : `${resultReason}\n`;
            writeToolOutput(eventId, output);
            emitToolResult(eventId, result, resultReason);
          }
          const suppressedCallList = suppressedResults
            .map(({ b }) => `${b.call.name} ${formatToolArgs(b.call)}`)
            .join("; ");
          const deniedContent = (b: BoundCall, resultReason: string): string =>
            `Tool ${b.call.name} result (exit=130, ok=false):\n` +
            `NOT EXECUTED — suppressed repeat. ${resultReason}\n\n` +
            `Suppressed call: ${b.call.name} ${formatToolArgs(b.call)}. ` +
            "This exact call is blocked for the rest of the turn; its earlier result is already in context — use it, or choose a different action.";
          if (historyNativeCalls.length) {
            appendAssistantWithTools(
              messages,
              beforeTool ?? "",
              historyNativeCalls,
              completion.reasoningBlock ??
                (assistantText.hasThinking && assistantText.thinkContent
                  ? { text: assistantText.thinkContent }
                  : undefined),
            );
            for (const { b, resultReason } of suppressedResults) {
              appendToolResult(messages, b.id, deniedContent(b, resultReason), b.call.name, false);
            }
          } else {
            const standardizedContent =
              (beforeTool ? beforeTool.trim() + "\n\n" : "") +
              bound
                .map((b) => `\`\`\`tool\n${JSON.stringify(b.call)}\n\`\`\``)
                .join("\n\n");
            pushAssistantHistory(standardizedContent);
            for (const { b, resultReason } of suppressedResults) {
              messages.push({ role: "tool", content: deniedContent(b, resultReason) });
            }
          }
          if (sequenceDecision.terminal) {
            const remainingCriteria = unreadResponderNotificationIds.size > 0
              ? ["Analyze and acknowledge the delivered Responder result without repeating completed foreground work."]
              : ["Continue with a materially different action that can produce new evidence."];
            outcomeState.outcome.status = "partial";
            await saveOutcomeState(outcomeState);
            moveTurn("partial", "repeated identical action sequence");
            const recoveryObservation = bound
              .map((entry) => loopGuard.getPriorObservation(entry.call.name, entry.call.args))
              .find((text) => typeof text === "string" && text.trim().length > 0);
            return finishTurn(
              `Stopped an identical action cycle before it could execute again. Blocked this turn: ${suppressedCallList}. Their earlier results are in context — continue from those, do not re-issue the same calls.`,
              productiveSteps,
              "partial",
              remainingCriteria,
              "The model repeated an identical action sequence without a new premise or state change.",
              undefined,
              {
                calls: suppressedCallList,
                ...(recoveryObservation?.trim()
                  ? { observation: recoveryObservation.trim().slice(0, 4000) }
                  : {}),
                signature: loopGuard.currentActionSequenceSignature() ?? suppressedCallList,
              },
            );
          }
          upsertActionCycleRecovery(
            reason +
              ` The repeated calls were: ${suppressedCallList}.` +
              (unreadResponderNotificationIds.size > 0
                ? " A delivered Responder result is still unread: analyze the available result, gather only genuinely necessary bounded evidence, then call job.read before returning to foreground work."
                : " The original successful tool results remain in context. Reassess that evidence and either finish or select a materially different action; do not replay completed work."),
          );
          continue;
        }

        if (sequenceDecision.warn && sequenceDecision.warnMessage) {
          writeNotice("warn", sequenceDecision.warnMessage);
          messages.push(
            recoveryUserMessage(sequenceDecision.warnMessage),
          );
        }

        // Notice BEFORE tool cards so the transcript reads:
        // thinking → response → "N tool calls…" → tool cards (not tools then info).
        if (allCalls.length > 1) {
          writeNotice(
            "info",
            `${allCalls.length} tool calls in this message — read-only in parallel, writes in order (failures do not cancel siblings)`,
          );
        }


        // Cards streamed from partial text can predate their arguments. The
        // executed call is authoritative, so refresh a stale card in place
        // (same event id → the reducer updates the queued row, no new card).
        const flushableDeferred = activeDeferredToolCalls.slice(
          0,
          allCalls.length,
        );
        for (let i = 0; i < flushableDeferred.length; i += 1) {
          const deferred = flushableDeferred[i]!;
          if (!deferred.call.name || deferred.call.name === "…") continue;
          const finalCall = allCalls[i];
          const stale =
            finalCall !== undefined &&
            (finalCall.name !== deferred.call.name ||
              formatToolArgs(finalCall) !== formatToolArgs(deferred.call));
          if (stale) {
            deferred.call = finalCall!;
            const refreshedLine =
              chalk.cyan(`  ▶ ${finalCall!.name}`) +
              chalk.gray(` ${formatToolArgs(finalCall!)}`);
            deferred.rendered =
              styleToolChatter(finalCall!, refreshedLine) + "\n";
          }
          if (!deferred.shown) {
            writeToolCall(deferred.eventId, deferred.call, deferred.rendered);
            deferred.shown = true;
          } else if (stale) {
            writeToolCall(deferred.eventId, deferred.call, "");
          }
        }

        if (historyNativeCalls.length) {
          appendAssistantWithTools(
            messages,
            beforeTool ?? "",
            historyNativeCalls,
            completion.reasoningBlock ??
              (assistantText.hasThinking && assistantText.thinkContent
                ? { text: assistantText.thinkContent }
                : undefined),
          );
        } else {
          const standardizedContent =
            (beforeTool ? beforeTool.trim() + "\n\n" : "") +
            allCalls
              .map((c) => `\`\`\`tool\n${JSON.stringify(c)}\n\`\`\``)
              .join("\n\n");
          pushAssistantHistory(standardizedContent);
        }


        const scopeForBatch = await loadScope().catch(() => undefined);

        const isParallelSafe = (c: ToolCall): boolean => {
          if (
            c.name === "pentest.recon" ||
            c.name === "net.context" ||
            c.name === "tool.batch" ||
            c.name === "tool.check" ||
            c.name === "shell.jobs" ||
            c.name === "shell.tail"
          ) {
            return true;
          }
          if (!BATCH_SAFE_TOOLS.has(c.name)) return false;
          try {
            return (
              classifyToolCall(c, { scope: scopeForBatch }).level === "safe"
            );
          } catch {
            return false;
          }
        };
        // Recon waves often emit 6–10 lookups; 4 forced a second sequential wave.
        const PARALLEL_LIMIT = 8;

        let aborted = false;
        let awaitingPlanApproval = false;
        /** Native tool_call ids that already have a role:tool history entry. */
        const recordedNativeIds = new Set<string>();
        /** Plan-mode soft reminders already attached this turn (by step). */
        const planRemindedAt = new Set<number>();
        /** True after a successful plan.create this turn (activePlan is turn-start snapshot). */
        let planCreatedThisTurn = Boolean(
          activePlan && activePlan.tasks.length > 0,
        );
        let actionSequenceExecuted = 0;
        let roundSuppressedCount = 0;
        let actionSequenceEligible = allCalls.length > 0;
        const actionSequenceOutcomes = new Map<string, string>();

        /**
         * Record a tool result into history. Failures / user declines are
         * always returned to the model — we never cancel later siblings or
         * force-end the turn as "blocked" because one tool failed. Only an
         * explicit user abort stops remaining calls.
         */
        const recordResult = (
          boundCall: BoundCall,
          res: {
            call: ToolCall;
            result: ToolResult;
            contextOutput: string;
            ok: boolean;
            lastAnswer?: string | undefined;
            aborted?: boolean | undefined;
            suppressedRepeat?: boolean | undefined;
            blockOrCancel?: boolean | undefined;
          },
        ): void => {
          consecutiveModelOnlyRounds = 0;
          recordedNativeIds.add(boundCall.id);
          actionSequenceExecuted += 1;
          if (res.suppressedRepeat) roundSuppressedCount += 1;
          const sequenceObservation = res.suppressedRepeat
            ? loopGuard.getPriorObservation(res.call.name, res.call.args) ??
              res.contextOutput
            : res.result.output ?? res.contextOutput;
          actionSequenceOutcomes.set(
            boundCall.id,
            JSON.stringify({
              ok: res.ok,
              exitCode: res.result.exitCode ?? null,
              digest: completedOperationObservationDigest(
                res.call.name,
                sequenceObservation,
              ),
            }),
          );
          // A policy-suppressed call is deterministic: replaying it verbatim
          // returns the identical receipt. It must therefore keep the sequence
          // eligible, otherwise the tool-level suppression and the sequence
          // guard cancel each other out and the round can repeat forever.
          actionSequenceEligible &&=
            (res.ok || Boolean(res.suppressedRepeat)) &&
            !res.blockOrCancel &&
            !res.aborted;
          if (res.ok && res.call.name === "plan.create") {
            planCreatedThisTurn = true;
          }
          if (!res.suppressedRepeat) productiveSteps += 1;
          // E5: collapse identical large tool bodies within this turn to a pointer.
          const deduped = dedupeToolContextOutput({
            content: res.contextOutput,
            toolName: res.call.name,
            artifactPath: res.result.outputPath,
            seenHashes: toolResultHashes,
          });
          const contextForHistory = deduped.content;
          // Soft plan-mode note on tool payloads only (never a user message).
          // Stop once a plan with tasks exists so we don't nag after plan.create.
          let toolContent = `Tool ${res.call.name} result (exit=${res.result.exitCode ?? 0}, ok=${res.result.ok}):\n${contextForHistory}`;
          const reminded = maybeAppendPlanModeReminder(toolContent, {
            isPlanMode,
            planApproved: session.planApproved.value,
            hasDraftPlan: planCreatedThisTurn,
            productiveStep: productiveSteps,
            alreadyRemindedAt: planRemindedAt,
            step: productiveSteps,
            kindHint:
              activePlan?.kind === "pentest" || pentestLikeTurn
                ? "pentest"
                : activePlan?.kind === "coding"
                  ? "coding"
                  : "general",
          });
          toolContent = reminded.content;
          if (reminded.reminded) {
            planRemindedAt.add(productiveSteps);
            // Chrome only — model already has the note on this tool result.
            writeNotice("info", PLAN_REMINDER_TOAST);
          }
          if (historyNativeCalls.length) {
            appendToolResult(
              messages,
              boundCall.id,
              toolContent,
              res.call.name,
              res.result.ok,
            );
          } else {
            messages.push({
              role: "tool",
              content: toolContent,
            });
          }
          // image.view hands back real image bytes. Tool results are text-only
          // on every provider wire, and images are only serialized on user
          // turns, so the bytes ride a deferred internal user message that
          // lands after the assistant→tool group is closed — inserting it here
          // would orphan the remaining tool results.
          if (res.result.images?.length) {
            deferredPostToolMessages.push({
              role: "user",
              internal: true,
              content:
                `[${res.call.name}] The ${res.result.images.length === 1 ? "image" : `${res.result.images.length} images`} you asked to look at ` +
                `${res.result.images.length === 1 ? "is" : "are"} attached to this message` +
                `${res.result.images.length === 1 ? "" : ", in the order you requested them"}: ` +
                `${res.result.images.map((image) => image.path ?? "(unnamed)").join(", ")}. ` +
                "Judge them from the pixels and continue the task.",
              images: res.result.images,
            });
          }
          // Reset retry counters — they track consecutive failures, not cumulative.
          truncatedToolRetries = 0;
          malformedFenceRetries = 0;
          bareToolJsonRetries = 0;

          if (
            res.ok &&
            (res.call.name === "fs.edit" ||
              res.call.name === "fs.write" ||
              res.call.name === "fs.writeMany" ||
              res.call.name === "fs.replaceLines" ||
              res.call.name === "fs.append")
          ) {
            // Mutation landed — post-fix summaries must not re-force tools.
            sawSuccessfulMutation = true;
          }
          // A fresh failed localhost probe re-opens the diagnosis→fix gate.
          if (
            (res.call.name === "http.fetch" ||
              res.call.name === "web.fetch" ||
              res.call.name === "shell.exec") &&
            localHttpProbeIsFailure(
              res.result.output ?? res.contextOutput ?? "",
            )
          ) {
            sawSuccessfulMutation = false;
          }
          if (res.ok && isEvidenceWorkTool(res.call.name)) {
            recovery.actionIntent = 0;
            recovery.errorFix = 0;
          }
          if (res.ok && res.call.name === "shell.start") sawServerStart = true;
          if (res.ok && res.call.name === "shell.tail") {
            sawServerTail = true;
            const tailOut = res.result.output ?? res.contextOutput ?? "";
            if (isServerReadyOutput(tailOut)) {
              sawServerStart = true;
              sawServerTail = true;
            }
          }
          if (
            res.ok &&
            res.call.name === "shell.exec" &&
            isPortListeningOutput(
              String(res.call.args.command ?? ""),
              res.result.output ?? res.contextOutput ?? "",
            )
          ) {
            sawServerStart = true;
          }
          if (
            res.ok &&
            (pentestLike || pentestSession) &&
            (res.call.name === "http.fetch" ||
              res.call.name === "shell.exec" ||
              res.call.name === "net.scan" ||
              res.call.name === "pentest.recon")
          ) {
            const blob = `${res.call.name} ${JSON.stringify(res.call.args)}`;
            if (
              /\b(sqlmap|hydra|nikto|nuclei|ffuf|gobuster|exploit|payload|idor|xss|union\s+select)\b/i.test(
                blob,
              ) ||
              (res.call.name === "http.fetch" &&
                typeof res.call.args.method === "string" &&
                !/^get$/i.test(res.call.args.method))
            ) {
              sawActivePentestTest = true;
            }
          }
          if (
            res.ok &&
            ((res.call.name === "http.fetch" &&
              /^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(
                String(res.call.args.url ?? ""),
              )) ||
              (res.call.name === "shell.exec" &&
                /\bcurl\b[\s\S]*\b(?:localhost|127\.0\.0\.1|\[::1\])\b/i.test(
                  String(res.call.args.command ?? ""),
                )))
          ) {
            const out = res.result.output ?? res.contextOutput ?? "";
            if (localHttpProbeIsFailure(out)) {
              sawFailedLocalHttpProbe = true;
              sawLocalHttpProbe = false;
            } else if (localHttpProbeIsSuccess(out)) {
              sawLocalHttpProbe = true;
              sawFailedLocalHttpProbe = false;
              recovery.failedProbe = 0;
            } else if (
              res.call.name === "shell.exec" &&
              !localHttpProbeIsFailure(out)
            ) {
              // curl without status line — soft success
              sawLocalHttpProbe = true;
              sawFailedLocalHttpProbe = false;
            }
          }
          // Track freestyle local-app materialization (scaffold / install / feature write)
          if (res.ok) {
            const cmd =
              typeof res.call.args.command === "string"
                ? res.call.args.command
                : "";
            const pathArg =
              typeof res.call.args.path === "string" ? res.call.args.path : "";
            if (isScaffoldCreateCommand(cmd)) {
              sawScaffoldOk = true;
              sawLocalAppMaterialWork = true;
            }
            if (isFeatureImplementationCall(res.call)) {
              sawFeatureImplWrite = true;
              sawLocalAppMaterialWork = true;
            }
            if (
              /\b(?:npm|pnpm|yarn|bun)\s+i(?:nstall)?\b/i.test(cmd) ||
              res.call.name === "fs.write" ||
              res.call.name === "fs.writeMany" ||
              res.call.name === "fs.edit" ||
              (pathArg &&
                getActiveProjectRoot() &&
                (pathArg.includes(getActiveProjectRoot()!) ||
                  !pathArg.startsWith("/")))
            ) {
              sawLocalAppMaterialWork = true;
            }
          }
          if (res.call.name === "plan.create" && res.ok) {
            sawPlanCreateOk = true;
            if (isPlanMode) {
              awaitingPlanApproval = true;
            } else {
              session.planApproved.value = true;
            }
            const kindArg =
              typeof res.call.args.kind === "string"
                ? res.call.args.kind
                : undefined;
            codingSession = codingSessionFromContext({
              buildLike,
              planKind: kindArg,
            });
          }
          // User Esc/Ctrl+C only — never cancel siblings because a delete failed
          // or a confirm was declined; the model must see every tool result.
          if (res.aborted) aborted = true;
        };

        // Multi-task sync guard: when one model message advances more than one
        // distinct task at once, hold the whole set behind a single reminder.
        // The model confirms by re-issuing the identical batch; a single-task
        // (or non-advancing) message clears any pending confirmation.
        batchRemindCalls = new Set<ToolCall>();
        batchReminderNote = "";
        {
          const livePlanForBatch = await loadPlan(session.sessionId).catch(
            () => undefined,
          );
          const intents: TaskUpdateIntent[] = [];
          for (const b of toRun) {
            const parsed = readTaskUpdateArgs(b.call);
            if (!parsed) continue;
            const resolvedId = livePlanForBatch
              ? resolvePlanTaskId(livePlanForBatch, parsed.taskId) ?? parsed.taskId
              : parsed.taskId;
            intents.push({ call: b.call, taskId: resolvedId, state: parsed.state });
          }
          const openIds = openingTaskIds(intents);
          if (openIds.length > 1) {
            // A multi-open is never confirmable; the store keeps at
            // most one active foreground task.
            session.pendingTaskBatch.value = undefined;
            const openDescriptors: BatchTaskDescriptor[] = openIds.map((taskId) => ({
              taskId,
              title:
                livePlanForBatch?.tasks.find((t) => t.id === taskId)?.title ?? "",
              targetState: "in_progress",
            }));
            batchReminderNote = buildMultiOpenRejection(openDescriptors);
            for (const intent of intents) {
              if (intent.state === "in_progress") batchRemindCalls.add(intent.call);
            }
            writeNotice("warn", multiOpenToast(openIds.length));
          } else if (isSimultaneousTaskAdvance(intents)) {
            const signature = batchUpdateSignature(intents);
            if (session.pendingTaskBatch.value === signature) {
              session.pendingTaskBatch.value = undefined;
              writeNotice("info", "confirmed batch task update — applying");
            } else {
              session.pendingTaskBatch.value = signature;
              const descriptors: BatchTaskDescriptor[] = intents.map((intent) => ({
                taskId: intent.taskId,
                title:
                  livePlanForBatch?.tasks.find((t) => t.id === intent.taskId)
                    ?.title ?? "",
                targetState: intent.state,
              }));
              batchReminderNote = buildMultiUpdateReminder(descriptors);
              for (const intent of intents) batchRemindCalls.add(intent.call);
              const advancing = distinctAdvancingTaskIds(intents).length;
              writeNotice("warn", multiUpdateToast(advancing));
            }
          } else {
            session.pendingTaskBatch.value = undefined;
          }
        }

        const groups = groupToolCallsForExecution(
          allCalls,
          isParallelSafe,
          PARALLEL_LIMIT,
        );
        for (const group of groups) {
          if (aborted || awaitingPlanApproval) break;
          if (group.length === 1) {
            const call = group[0]!;
            const bc = callToBound.get(call);
            if (!bc) continue;
            if (!callIds[bc.index]) {
              callIds[bc.index] = `tool-${++nextToolEventId}`;
            }
            const id = callIds[bc.index]!;
            const res = await executeSingleTool(
              call,
              id,
              options.signal || new AbortController().signal,
            );
            recordResult(bc, res);
          } else {
            // Concurrent group — BoundCall via Map; record in document order.
            const groupBound: BoundCall[] = [];
            const uiIds: string[] = [];
            for (const c of group) {
              const bc = callToBound.get(c);
              if (!bc) continue;
              if (!callIds[bc.index]) {
                callIds[bc.index] = `tool-${++nextToolEventId}`;
              }
              groupBound.push(bc);
              uiIds.push(callIds[bc.index]!);
            }
            const results = await Promise.all(
              groupBound.map((bc, k) =>
                executeSingleTool(
                  bc.call,
                  uiIds[k]!,
                  options.signal || new AbortController().signal,
                ),
              ),
            );
            for (let k = 0; k < results.length; k += 1) {
              recordResult(groupBound[k]!, results[k]!);
            }
          }
        }

        // Cards still "running" get a terminal UI result; history always pairs.
        // Only abort / plan-gate / governor leave calls un-run now.
        for (let i = 0; i < toRun.length; i += 1) {
          const bc = toRun[i]!;
          if (recordedNativeIds.has(bc.id)) continue;
          if (!callIds[i]) {
            callIds[i] = `tool-${++nextToolEventId}`;
          }
          const uiId = callIds[i]!;
          const reason = aborted
            ? "Cancelled — turn aborted before this call ran."
            : awaitingPlanApproval
              ? "Deferred — waiting for plan approval."
              : "Cancelled — not executed.";
          const result: ToolResult = {
            ok: false,
            output: reason,
            exitCode: 130,
          };
          if (alreadyPrintedIds.has(uiId)) {
            emitToolResult(uiId, result, reason);
          }
          if (historyNativeCalls.length) {
            appendToolResult(
              messages,
              bc.id,
              `Tool ${bc.call.name} result (exit=130, ok=false):\n${reason}`,
              bc.call.name,
              false,
            );
            recordedNativeIds.add(bc.id);
          } else {
            messages.push({
              role: "tool",
              content: `Tool ${bc.call.name} result (exit=130, ok=false):\n${reason}`,
            });
          }
        }

        // Synthetic results for deferred/omitted ids still listed on assistant.
        if (historyNativeCalls.length) {
          for (const b of bound) {
            if (runIds.has(b.id) || recordedNativeIds.has(b.id)) continue;
            appendToolResult(
              messages,
              b.id,
              `Tool ${b.call.name} result (exit=130, ok=false):\n${deferReason}`,
              b.call.name,
              false,
            );
            recordedNativeIds.add(b.id);
          }
          fillMissingToolResults(
            messages,
            historyNativeCalls,
            "Cancelled — not executed this turn.",
          );
        }

        const actionSequenceOutcome = createHash("sha256")
          .update(
            JSON.stringify(
              bound.map((entry) => actionSequenceOutcomes.get(entry.id) ?? null),
            ),
          )
          .digest("hex")
          .slice(0, 24);
        loopGuard.completeActionSequence(
          actionSequenceCalls,
          actionSequenceEligible &&
            toRun.length === bound.length &&
            actionSequenceExecuted === allCalls.length &&
            !aborted &&
            !awaitingPlanApproval,
          actionSequenceOutcome,
        );

        consecutiveSynthesizedRounds =
          !aborted && actionSequenceExecuted > 0 && roundSuppressedCount === actionSequenceExecuted
            ? consecutiveSynthesizedRounds + 1
            : 0;
        if (consecutiveSynthesizedRounds >= 2) {
          const repeatedList = bound
            .map((b) => `${b.call.name} ${formatToolArgs(b.call)}`)
            .join("; ");
          outcomeState.outcome.status = "partial";
          await saveOutcomeState(outcomeState);
          moveTurn("partial", "repeated identical action cycle");
          const recoveryObservation = bound
            .map((entry) => loopGuard.getPriorObservation(entry.call.name, entry.call.args))
            .find((text) => typeof text === "string" && text.trim().length > 0);
          return finishTurn(
            `Stopped an identical action cycle: consecutive rounds re-issued calls whose results are already in context (${repeatedList}). Continue from those results or take a materially different action.`,
            productiveSteps,
            "partial",
            ["Continue with a materially different action that can produce new evidence."],
            "Every call in consecutive rounds repeated already-answered work.",
            undefined,
            {
              calls: repeatedList,
              ...(recoveryObservation?.trim()
                ? { observation: recoveryObservation.trim().slice(0, 4000) }
                : {}),
              signature: loopGuard.currentActionSequenceSignature() ?? repeatedList,
            },
          );
        }

        // Keep ledger system rows outside the native assistant→tool group so
        // protocol repair preserves the real successful job.read body.
        for (const notification of deferredResponderLedgerNotifications.splice(0)) {
          upsertResponderResultLedger(messages, notification);
        }

        // SESSION STATE only after the assistant→tool group is closed.
        // Mid-group upserts were the root cause of "No stored body" thrash.
        refreshSessionState(pendingSessionStatePlan);

        if (
          responderWakeTurn &&
          unreadResponderNotificationIds.size > 0 &&
          !allCalls.some(
            (candidate) =>
              candidate.name === "job.read" || candidate.name === "task.read",
          )
        ) {
          messages.push(
            recoveryUserMessage(
              "The delivered Responder result is still unread. Decide from the evidence already available whether it is understood. If it is, call job.read now; if not, gather only the smallest bounded evidence needed. Do not resume or repeat unrelated foreground work before resolving this receipt.",
            ),
          );
        }

        if (deferredPostToolMessages.length > 0) {
          messages.push(...deferredPostToolMessages.splice(0));
        }

        if (awaitingPlanApproval) {
          pendingCalls = [];
          outcomeState.outcome.status = "partial";
          await saveOutcomeState(outcomeState);
          moveTurn("partial", "draft plan awaits approval");
          return finishTurn(
            "",
            productiveSteps,
            "partial",
            ["Approve or revise the draft plan before implementation."],
          );
        }

        if (aborted) {
          lastAnswer = "";
          outcomeState.outcome.status = "aborted";
          await saveOutcomeState(outcomeState);
          moveTurn("aborted", "turn aborted");
          writeAbort();
          return finishTurn(lastAnswer, productiveSteps, "aborted");
        }
        // Confirm declines / tool failures already have role:tool results —
        // continue the agent loop so the model can adapt (do not force "blocked").

        await maybeAutoCompact("post-tool-token-budget");

        if (options.onMessages) {
          try {
            options.onMessages(buildTurnHistory(liveMessages, lastAnswer));
          } catch {
            // ignore
          }
        }
      }
    }


    // Hard iteration ceiling (hundreds of steps) — rare. Mid-turn governor
    // pauses already confirm for non-coding; coding never hard-pauses there.
    const richSummary = await buildRichStopSummary(
      messages,
      session,
      productiveSteps,
    );
    lastAnswer = richSummary;
    outcomeState.outcome.status = "paused_budget";
    await saveOutcomeState(outcomeState);
    moveTurn("paused_budget", "emergency iteration ceiling reached");
    return finishTurn(
      lastAnswer,
      productiveSteps,
      "paused_budget",
      ["Continue unfinished work in a subsequent turn."],
      "The emergency iteration ceiling was reached.",
    );
  } catch (error) {
    const isAbort = isAbortError(error, options.signal);
    if (isAbort) {
      writeAbort();
      return finishTurn("", 0, "aborted");
    }
    releaseUnreadResponderClaims();
    const msg = `Error: ${error instanceof Error ? error.message : String(error)}`;
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, msg));
      } catch {
        // ignore
      }
    }
    emit({
      type: "turn-error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/** Compatibility boundary for callers that consume visible assistant text. */
export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  return (await runAgentTurn(prompt, options)).answer;
}
