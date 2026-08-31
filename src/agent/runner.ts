import { join } from "node:path";
import type { McpRuntime, McpTurnLease } from "../mcp/runtime.js";
import { hasMcpMentionSyntax } from "../mcp/mentions.js";
import { isCanonicalToolName } from "../mcp/names.js";
import type {
  ChatMessage,
  ChatImage,
  CompletionResult,
  Mode,
  NativeToolCall,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../types.js";
import { completeWithProvider, streamWithProvider } from "../llm/router.js";
import {
  REQUEST_CONTEXT_PREFIX,
  upsertRequestContextMessage,
} from "../llm/system-messages.js";
import { operationUsageFromError } from "../llm/operation-ledger.js";
import { contextAttemptFromOperationUsage } from "../llm/context-snapshot.js";
import { providerInputTokenBudget } from "../llm/context-windows.js";
import { resolveBuiltInProfile } from "../llm/provider-profiles.js";
import { streamAlreadyEmitted } from "../llm/stream-progress.js";
import {
  classifyStreamFailure,
  createStreamRecoveryState,
  resetStreamRecoveryState,
} from "./stream-recovery.js";
import { trimExactContinuationOverlap } from "./turn/continuation-overlap.js";
import type {
  SingleToolResult,
  TurnEventPort,
  TurnOutputState,
} from "./turn/contracts.js";
import { finalizeTurn } from "./turn/finalizer.js";
import { suppressRepeatedActionSequence } from "./turn/loop/sequence-suppression.js";
import { applyTaskUpdateLedgerTransition } from "./turn/tool-execution/plan-tool-ledger.js";
import { accountToolOutcome } from "./turn/outcome-accounting.js";
import { resolveFinalOutcome } from "./turn/loop/final-outcome.js";
import {
  createWireOccurrenceLedger,
  type ReplayedOccurrence,
} from "./turn/loop/wire-occurrences.js";
import {
  createPromptMutex,
  invalidToolCall,
  readSalvagedWriteReceipt,
  salvagedWriteCall,
  type SalvagedWriteReceipt,
} from "./turn/tool-call-preparation.js";
import {
  createSessionStateRefresher,
  persistProjectRootOnPlan as persistPlanProjectRoot,
  persistTaskEvidence as persistPlanTaskEvidence,
  type PlanMutator,
} from "./turn/plan-persistence.js";
import type { TurnOutcome } from "./turn-outcome.js";
import { createTurnEventEmitter } from "./turn/event-emitter.js";
import { createToolResultRecorder } from "./turn/tool-result-recorder.js";
import { ResponderClaimLedger } from "./turn/responder-claims.js";
import { buildPromptSections } from "./turn/prompt-sections.js";
import { buildSystemSections } from "./turn/system-sections.js";
import { buildTurnSessionStateSnapshot } from "./turn/session-state-projection.js";
import { createToolRouting } from "./turn/tool-routing.js";
import { createToolWatchdog } from "./turn/tool-watchdog.js";
import { evaluateTaskBatchGuard } from "./turn/task-batch-guard.js";
import { readToolEvidenceSignals } from "./turn/tool-evidence-signals.js";
import { decidePlanModeGate } from "./turn/plan-mode-gate.js";
import { autostartPlanTask } from "./turn/task-autostart.js";
import { decideScaffoldPreflight } from "./turn/scaffold-preflight.js";
import { createCompactionCoordinator } from "./turn/compaction-coordinator.js";
import { createTurnHistoryWriter } from "./turn/history-writer.js";
import { linkResponderJobToPlan } from "./turn/responder-job-linkage.js";
import { reconcileScaffoldOutcome } from "./turn/scaffold-outcome.js";
import { shouldYieldForDeclaredResponderDependency as declaredResponderDependencyYields } from "./turn/responder-dependency.js";
import { authorizeToolExecution } from "./turn/tool-execution/authorization.js";
import { resolveToolDispatch } from "./turn/tool-execution/dispatch.js";
import {
  recoverFromStreamFailure,
  type StreamFailureState,
} from "./turn/loop/stream-failure.js";
import {
  assembleRequest,
  type RequestAssemblyState,
} from "./turn/loop/request-assembly.js";
import { createStreamSession } from "./turn/loop/stream-session.js";
import {
  loadTurnInstructions,
  orientTurnWorkspace,
} from "./turn/workspace-setup.js";
import { readTaskWorkSignals } from "./turn/task-work-signals.js";
import { superviseToolExecution } from "./turn/tool-execution/supervision.js";
import {
  firstNativeToolCall,
  syncNativeToolCallCards,
} from "./turn/loop/native-tool-calls.js";
import { recoverMissingToolCall } from "./turn/loop/tool-call-recovery.js";
import {
  handleEmptyResponse,
  type EmptyResponseState,
} from "./turn/loop/empty-response.js";
import {
  handleOutputBudgetExhaustion,
  outputBudgetExhausted,
  routeCompletionBudget,
  type OutputBudgetState,
} from "./turn/loop/output-budget.js";
import {
  hasTruncatedNativeWrite,
  salvageTruncatedNativeWrite,
} from "./turn/loop/native-write-salvage.js";
import {
  accountCompletionUsage,
  interpretCompletion,
} from "./turn/loop/completion-interpretation.js";
import {
  evaluateLoopGuardBlock,
  evaluateToolGuards,
  LOOP_RESET_OUTPUT,
  readRetryReason,
} from "./turn/tool-execution/guards.js";
import {
  decideResponderRead,
  parseResponderReadRequest,
} from "./turn/responder-read-tool.js";
import {
  decideTaskUpdateDoneGate,
  parseTaskUpdateRequest,
} from "./turn/task-update-gate.js";
import {
  evaluateTaskCompletionGate,
  planHasVerifiedRemoteWork,
  planHasVerifiedRuntime,
  resolveLedgerForTaskGate,
} from "./turn/task-gate.js";
import {
  createMcpAgentCallFailure,
  createMcpAgentToolExecutor,
} from "./turn/mcp-agent-tools.js";
import {
  createResponderInboxRefresher,
  findResponderWakeNotification,
  parseResponderWake,
  responderWakeMatchesRevision,
} from "./turn/responder-inbox.js";
import {
  createCompactionSummarizer,
  type CompactionExecutionState,
} from "./turn/compaction-summarizer.js";
import { createCompactionRequestEstimator } from "./turn/compaction-request-estimator.js";
import { createCompactionDurableEnvelopeBuilder } from "./turn/compaction-durable-envelope.js";
import { selectCompactionReplaySnapshot } from "./turn/compaction-replay-selection.js";
import { executeAutomaticCompaction } from "./turn/automatic-compaction-execution.js";
import { prepareCompactionCandidateMessages } from "./turn/compaction-candidate.js";
import { measureCompactionFinalFit } from "./turn/compaction-final-fit.js";
import { planCompactionAdmission } from "./turn/compaction-admission.js";
import {
  compactionFailureMessage,
  compactionSummaryText,
} from "./turn/compaction-messages.js";
import {
  syntheticToolCallId,
  isTextOnlyModel,
  markTextOnlyModel,
  type ToolCallingMode,
} from "../llm/tool-protocol.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../ui-core/rendering/sanitize-display.js";
import { createHash, randomUUID } from "node:crypto";
import {
  jobManager,
  type BackgroundJob,
  type ResponderNotification,
} from "../tools/jobs.js";
import { upsertResponderResultLedger } from "./responder-context.js";
import {
  agentModeDirective,
  planModeDirective,
  renderRequestEnvironmentContext,
  scratchDirFor,
  toolNudge,
} from "../prompts/index.js";
import { getConfig, getProviderModel } from "../store/config.js";
import {
  beginSessionWorkspace,
  getActiveSessionWorkspace,
} from "../store/session-workspace.js";
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
  normalizeToolCall,
  runToolCall,
  BATCH_SAFE_TOOLS,
} from "../tools/registry.js";
import {
  RUNNER_META_TOOL_NAMES,
  MCP_AGENT_TOOL_NAMES,
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
  fillMissingToolResults,
  repairToolProtocol,
} from "./tool-history.js";
import {
  legacyReasoningBlockFromArtifacts,
  reasoningArtifactsForPersistence,
} from "../llm/reasoning-artifacts.js";
import {
  estimateTokens,
  estimateMessagesTokens,
  shouldApplyAutoCompact,
  isCompactionMemoryMessage,
} from "./context-manager.js";
import {
  describeDominantContextBlock,
} from "./context-breakdown.js";
import { recordRequestTokenObservation } from "../llm/token-estimate-calibration.js";
import { RequestOverLimitError } from "./request-accounting.js";
import {
  freeTierGuardNotices,
  getReliabilityPolicy,
  MAX_STEP_COMPLETION_TOKENS,
} from "./reliability-policy.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import {
  upsertActiveSkillsMessage,
  upsertAgentInstructionsMessage,
} from "./injected-blocks.js";
import { getSkillIndex } from "../skills/registry.js";
import {
  renderSkillCatalog,
} from "../skills/catalog.js";
import { loadScopeForSession, isScopeActive } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  rememberThinking,
  stripThinking,
} from "../ui/thinking.js";
import { hasReasoningMarker } from "../llm/reasoning-marker.js";
import { safeCwd } from "../os/cwd.js";
import {
  analyzeTask,
  formatTaskAnalysisHint,
  isNarrowExplicitNmapOperation,
} from "./task-analyzer.js";
import { computeMaxIterations, computeStepBudget } from "./step-budget.js";
import { isScratchOnlyWrite } from "./scratch-write.js";
import { WorkLedger } from "./durable-envelope.js";
import { normalizeCompactionSummary } from "./compaction-summary.js";
import {
  isOperationPolicyError,
  OperationLedger,
  singleAdmissionOperationPolicy,
} from "../llm/operation-ledger.js";
import { LoopGuard } from "./loop-guard.js";
import {
  appendInterruptedReasoning,
  interruptedReasoningBrief,
} from "./interrupted-reasoning.js";
import {
  CompactionAttemptLedger,
} from "./compaction-attempt.js";
import {
  loadPlan,
  savePlan,
  mutatePlan,
  markTask,
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
import { resolveFsToolPath } from "../tools/fs.js";
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
  absorbLooseWorkIntoLedger,
  applyDestinationCwd,
  canMarkTaskDone,
  classifyTaskTitle,
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
  recordTaskWorkSuccess,
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
  upsertSessionStateMessage,
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
  getActiveProjectRoot,
  setActiveProjectRootIfValid,
} from "./project-root.js";
import {
  buildWorkspaceOrientation,
  isScaffoldCancelledOutput,
  scaffoldLooksMaterialized,
  scaffoldTargetConflictMessage,
  resolveScaffoldTargetPath,
} from "./workspace-orient.js";
import {
  stdioConfirmPort,
  stdioSecretRequester,
  restoreInteractiveStdin,
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
  return declaredResponderDependencyYields(
    plan,
    runningJobs,
    notifications,
    currentNotificationId,
  );
}

export interface AgentRunOptions {
  mcp?: McpRuntime | undefined;
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  toolCalling?: ToolCallingMode | undefined;
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
  onSuccessfulRequest?:
  | ((snapshot: SuccessfulRequestSnapshot) => void)
  | undefined;
  /**
   * The session's last successful main request from an earlier turn. Seeds the
   * local snapshot so a first-iteration auto-compaction can still replay the
   * exact cached prefix instead of re-rendering the transcript.
   */
  previousSuccessfulRequest?: SuccessfulRequestSnapshot | undefined;
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
  const eventPort: TurnEventPort = {
    emit: (event) => options.onEvent?.(event),
  };
  const emit = eventPort.emit;
  const outputState: TurnOutputState = { visibleCommitted: false };
  // Whether the CURRENT model iteration has already committed its visible
  // prose to the transcript with an `assistant-message` event. The recovery
  // paths preserve streamed prose before retrying (so it isn't wiped by the
  // next tool-call/turn event); this flag stops them from re-committing prose
  // the normal tool path already surfaced, which would render it twice. Reset
  // at the top of every loop iteration.
  let interruptedVisible = "";
  let interruptedReasoning = "";
  let lowYieldResumptions = 0;
  const {
    writeStatus,
    writeNotice,
    writeAssistantMessage,
    writeThinkingBlock,
    writeToolOutput,
    writeToolCall,
    writePlanUpdate,
    writeToolBlocked,
    writeAbort,
    emitToolResult,
    writeCompactionStarted,
    writeCompactionDelta,
    writeCompactionCompleted,
    writeCompactionFailed,
  } = createTurnEventEmitter(eventPort, outputState);
  // Points at the live message array so finishTurn can hand the full
  // conversation back to the caller. Assigned once `messages` is built below;
  // all later mutations are in-place so this reference stays current.
  let liveMessages: ChatMessage[] = [];
  let suppressOutcomeDiagnostics = false;
  // No session filter: the ledger is created in the outer turn scope, before the
  // session policy exists, and every id it holds is already known to belong to
  // this turn (notification ids are globally unique).
  const responderClaims = new ResponderClaimLedger({
    getPendingNotifications: () => jobManager.getPendingNotifications(),
    releaseClaim: (notificationId) =>
      jobManager.releaseResponderNotificationClaim(notificationId),
  });
  const finishTurn = (
    answer: string,
    steps: number,
    status: TurnOutcomeStatus = "succeeded",
    remainingCriteria: readonly string[] = [],
    reason?: string,
    displayAnswer?: string,
    loopGuardStop?: LoopGuardStopInfo,
  ): TurnOutcome =>
    finalizeTurn(
      {
        releaseResponderClaims: () => responderClaims.release(),
        liveMessages: () => liveMessages,
        diagnostics: () => !suppressOutcomeDiagnostics,
        writeAssistantMessage,
        emitEmptyAssistantMessage: () =>
          emit({ type: "assistant-message", text: "" }),
        emitTurnEnd: ({ outcome, finalAnswer, steps: endSteps }) =>
          emit({ type: "turn-end", outcome, finalAnswer, steps: endSteps }),
        onMessages: options.onMessages,
        onOutcome: options.onOutcome,
      },
      {
        answer,
        steps,
        status,
        remainingCriteria,
        reason,
        displayAnswer,
        loopGuardStop,
      },
    );

  let mcpLease: McpTurnLease | undefined;

  try {
    emit({
      type: "turn-start",
      prompt,
      ...(options.displayPrompt !== undefined
        ? { displayPrompt: options.displayPrompt }
        : {}),
    });
    const config = getConfig();
    const mcpRuntime = options.mcp;
    const mcpMentioned = hasMcpMentionSyntax(prompt);
    if (
      mcpRuntime &&
      (mcpRuntime.getState().selection.mode !== "off" || mcpMentioned)
    ) {
      await mcpRuntime.ensureReady();
    }
    if (mcpRuntime && mcpMentioned) mcpRuntime.applyMentionSelection(prompt);
    const mcpToolDefinitions =
      mcpRuntime?.toolDefinitions({ ...(agentMode === "ask" ? { askMode: true } : {}) }) ?? [];
    mcpLease = mcpRuntime?.beginTurn();
    const mcpToolNames = mcpToolDefinitions.map((definition) => definition.name);
    const maxSteps = options.maxSteps ?? 70;
    const confirmPort = options.confirm ?? stdioConfirmPort;
    const projectContext = await loadProjectContext();
    const skillIndex = await getSkillIndex({
      cwd: safeCwd(),
      ...(getActiveProjectRoot() ? { projectRoot: getActiveProjectRoot()! } : {}),
    });
    const skillsAvailable = skillIndex.skills.length > 0;
    const hasAttachedImages = Boolean(options.images?.length);
    const imageOcrEnabled = shouldEnableImageOcr(
      prompt,
      hasAttachedImages,
      options.visionProven !== false,
    );
    const initialProvider = options.provider ?? config.defaultProvider;
    const initialModel = options.model ?? getProviderModel(initialProvider);
    const toolRouting = createToolRouting({
      mode: agentMode,
      mcpPresent: Boolean(mcpRuntime),
      mcpToolNames,
      mcpToolDefinitions,
      imageOcrEnabled,
      skillsAvailable,
      toolCalling: options.toolCalling ?? config.toolCalling,
      useCompactSystemPrompt: () => useCompactSystemPrompt,
    });
    const routeToolNames = toolRouting.routeToolNames;
    const resolveNativeTools = toolRouting.resolveNativeTools;
    // image.view is different from optimistic user-attachment handling: once
    // the tool succeeds, the model must actually receive and inspect its bytes.
    // Offer it only with affirmative capability evidence for the active route.
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
    // Some free-tier routes have a per-request/per-minute input budget below
    // the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget = providerInputTokenBudget(provider, model);
    const useCompactSystemPrompt = inputTokenBudget !== undefined;
    const selectToolDefs = (
      native: boolean,
      compact: boolean,
      routeProvider: ProviderId = provider,
      routeModel: string = model,
    ): ToolDefinition[] | undefined =>
      toolRouting.selectToolDefs(native, compact, routeProvider, routeModel);
    const buildStableSystemContent = (native: boolean): string =>
      toolRouting.buildStableSystemContent(native, provider, model);
    let { dialect: toolDialect, native: nativeToolsActive } = resolveNativeTools(
      provider,
      model,
    );
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

    const { destinationHint, instructionScanInput } = orientTurnWorkspace({
      prompt,
      plan: activePlan,
      cwd: safeCwd(),
    });
    const turnInstructions = await loadTurnInstructions({
      prompt,
      scanInput: instructionScanInput,
      scaffoldInstructionFiles: !idleOrSocialPrompt && !informationalQuery,
      skillNames: skillsAvailable ? skillIndex.names : new Set<string>(),
      notify: writeNotice,
    });
    let agentInstructionsBlock = turnInstructions.block;
    const activeSkillsBlock = turnInstructions.skillsBlock;
    const selectedSkillNames = turnInstructions.selectedSkillNames;
    const refreshAgentInstructions = async (): Promise<void> => {
      agentInstructionsBlock = await turnInstructions.refresh();
    };

    // Only long-lived instructions belong in the provider-cached system prefix.
    // Request, project, workspace, recovery, scope, and plan state are appended
    // later as system-marked turns so a changing byte cannot invalidate the
    // constitution (and, on Anthropic, the native tool schemas before it).
    // The red-team methodology block is ~940 tokens on every request. Attach it
    // only when this turn is actually a remote-security engagement.
    const pentestPromptTurn =
      pentestLikeTurn || activePlan?.kind === "pentest";
    const { sections: systemSections, pentestSession } = await buildSystemSections({
      prompt,
      mode: agentMode,
      plan: activePlan,
      history: options.history,
      previousTurn: options.previousTurn,
      sessionId: session.sessionId,
      projectContext,
      destinationHint,
      isPlanMode,
      buildLikeTurn,
      informationalQuery,
      idleOrSocialPrompt,
      narrowNmapOperation,
      pentestLikeTurn,
      skillsAvailable,
      skillIndex,
      selectedSkillNames,
      inputTokenBudget,
      getMcpContext: () =>
        mcpRuntime?.promptContext({
          nativeTools: false,
          ...(agentMode === "ask" ? { askMode: true } : {}),
        }),
      getProjectRoot: getActiveProjectRoot,
      getRunningJobs: () => jobManager.getRunningJobs(session.sessionId),
      getRecentJobs: () => jobManager.getRecentJobs(12, session.sessionId),
    });
    const promptSections = (): AgentPromptSection[] =>
      buildPromptSections({
        systemSections,
        selectedSkillNames,
        prompt,
        mode: agentMode,
      });
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
    const requestContextMessage = `${REQUEST_CONTEXT_PREFIX}\n${requestContext}`;
    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...(options.history ?? []),
      userMessage,
      { role: "system", content: requestContextMessage },
    ];
    liveMessages = messages;
    const refreshInjectedBlocks = (): void => {
      upsertAgentInstructionsMessage(messages, agentInstructionsBlock);
      upsertActiveSkillsMessage(messages, activeSkillsBlock);
    };
    refreshInjectedBlocks();
    if (activePlan) {
      upsertPlanContextMessage(
        messages,
        planContextMessage(activePlan, session.planApproved.value),
      );
    }
    const responderWake = parseResponderWake({
      prompt,
      displayPrompt: options.displayPrompt,
    });
    const responderWakeTurn = responderWake.wakeTurn;
    const responderWakeNotificationId = responderWake.notificationId;
    const responderWakeJobId = responderWake.jobId;
    const responderWakeResultRevision = responderWake.resultRevision;
    const matchesWakeRevision = (notification: ResponderNotification): boolean =>
      responderWakeMatchesRevision(responderWake, notification);
    const wakeNotification = findResponderWakeNotification(
      responderWake,
      jobManager.getPendingNotifications(session.sessionId),
    );
    if (wakeNotification) {
      responderClaims.add(wakeNotification.id);
    }
    const refreshResponderInbox = createResponderInboxRefresher({
      messages,
      wake: responderWake,
      claims: responderClaims,
      getRunningJobs: () => jobManager.getRunningJobs(session.sessionId),
      getPendingNotifications: () =>
        jobManager.getPendingNotifications(session.sessionId),
      getResponderLeaseId: () =>
        jobManager.getResponderLeaseId(session.sessionId),
      claimNextNotification: (leaseId) =>
        jobManager.claimNextResponderNotification(session.sessionId, leaseId),
    });
    /** Assigned after session flags exist — see below. */
    let refreshSessionState: (
      plan?: SessionPlan | null | undefined,
    ) => void = () => undefined;
    const {
      recoveryUserMessage,
      upsertActionCycleRecovery,
      recoveryProse,
      pushAssistantHistory,
    } = createTurnHistoryWriter({
      messages,
      images: options.images,
      sanitizeAssistantText,
      visibleCommitted: () => outputState.visibleCommitted,
      writeAssistantMessage,
    });

    const loopGuard = new LoopGuard();
    // Uncalibrated estimate for the request currently in flight. Paired with the
    // provider's reported prompt size below so the estimator learns this route's
    // bias instead of permanently over-reporting it.
    let dispatchedRawRequestTokens = 0;
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
    let continuationBudgetFloor = 0;

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
    let instructionsChangedThisRound = false;
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

    const taskGatePorts = {
      getLiveLedger: () => taskWorkLedger,
      setLiveLedger: (ledger: TaskWorkLedger) => {
        taskWorkLedger = ledger;
      },
      getLooseWork: () => sessionLooseWork,
      featureAppRequired: featureAppAsk,
      existingProject: () =>
        scaffoldLooksMaterialized(getActiveProjectRoot()),
    };
    const ledgerForTaskGate = (
      plan: SessionPlan,
      taskId: string,
    ): TaskWorkLedger | null =>
      resolveLedgerForTaskGate(taskGatePorts, plan, taskId);

    const completionGateForTask = (
      plan: SessionPlan,
      taskId: string,
    ): ReturnType<typeof canMarkTaskDone> =>
      evaluateTaskCompletionGate(taskGatePorts, plan, taskId);

    const mutateSessionPlan: PlanMutator = (mutator) =>
      mutatePlan(session.sessionId, mutator);
    const persistProjectRootOnPlan = (root: string): Promise<void> =>
      persistPlanProjectRoot(mutateSessionPlan, root);
    const persistTaskEvidence = (
      taskId: string,
      evidence: TaskEvidence,
    ): Promise<void> =>
      persistPlanTaskEvidence(mutateSessionPlan, taskId, evidence);

    refreshSessionState = createSessionStateRefresher({
      messages,
      prompt,
      requestContextMessage,
      refreshInjectedBlocks,
      suppressed: () => idleOrSocialPrompt || informationalQuery,
      activePlan: () => activePlan,
      planApproved: () => session.planApproved.value,
      runningJobs: () => jobManager.getRunningJobs(session.sessionId),
      projectRoot: getActiveProjectRoot,
      requiresState: () => buildLikeTurn || pentestLikeTurn,
      snapshotFlags: () => ({
        featureAppRequired: featureAppAsk,
        featureSeen: sawFeatureImplWrite,
        scaffoldOk: sawScaffoldOk,
        serverStarted: sawServerStart,
        serverProbedOk: sawLocalHttpProbe,
        lastProbeFailed: sawFailedLocalHttpProbe,
        lastOkTool: taskWorkLedger?.lastOkTool,
        pentestSession,
      }),
    });
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
    const wireOccurrences = createWireOccurrenceLedger({
      isPrinted: (eventId) => alreadyPrintedIds.has(eventId),
      writeToolCall,
      markPrinted: (eventId) => alreadyPrintedIds.add(eventId),
      emitToolStart: (eventId) => emit({ type: "tool-start", id: eventId }),
      writeToolOutput: (eventId, chunk) => writeToolOutput(eventId, chunk),
      emitToolResult,
    });

    const promptMutex = createPromptMutex();

    /**
     * Apply a salvaged partial write through the NORMAL tool path so the
     * classifier, scope/engagement gates, confirmation prompt, and receipts
     * all apply exactly as they would for a model-emitted call. Salvage must
     * never mutate a file with `confirmed: true`, and an `fs.append` that was
     * cut off must stay an append (with its precondition) instead of becoming
     * a full overwrite.
     */
    function showMcpAgentCall(toolEventId: string, call: ToolCall): void {
      if (alreadyPrintedIds.has(toolEventId)) return;
      writeToolCall(toolEventId, call);
      alreadyPrintedIds.add(toolEventId);
    }

    const mcpAgentToolPorts = {
      askMode: agentMode === "ask",
      showCall: showMcpAgentCall,
      writeOutput: (toolEventId: string, chunk: string) =>
        writeToolOutput(toolEventId, chunk, { replace: true }),
      emitResult: emitToolResult,
      confirm: async (call: ToolCall): Promise<boolean> => {
        const releasePrompt = await promptMutex.acquire();
        try {
          const confirmed = await confirmToolExecution(
            call,
            Boolean(options.autoConfirm),
            session,
            confirmPort,
          );
          restoreInteractiveStdin();
          return confirmed;
        } finally {
          releasePrompt();
        }
      },
      recordAttempt: (call: ToolCall, ok: boolean, output: string) =>
        loopGuard.recordAttempt(step, call.name, call.args, ok, 0, output),
    };
    const failMcpAgentCall = createMcpAgentCallFailure(mcpAgentToolPorts);
    const executeMcpAgentCall = createMcpAgentToolExecutor(mcpAgentToolPorts);

    async function applySalvagedWrite(
      salvaged: SalvagedWrite,
    ): Promise<SalvagedWriteReceipt> {
      const executed = await executeSingleTool(
        salvagedWriteCall(salvaged),
        `tool-${++nextToolEventId}`,
        options.signal || new AbortController().signal,
      );
      return readSalvagedWriteReceipt(salvaged, executed);
    }

    async function executeSingleTool(
      rawCall: ToolCall,
      toolEventId: string,
      parentSignal: AbortSignal,
    ): Promise<SingleToolResult> {

      const scratchDir = scratchDirFor(safeCwd());
      const normalizedCall = normalizeToolCall(rawCall);
      const canonicalMcpName = mcpRuntime?.canonicalizeToolName(normalizedCall.name);
      let call =
        canonicalMcpName && canonicalMcpName !== normalizedCall.name
          ? { ...normalizedCall, name: canonicalMcpName }
          : normalizedCall;

      const emitVisibleSyntheticReceipt = (
        result: ToolResult,
        summary: string,
      ): void => {
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(toolEventId, call);
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

      const invalid = invalidToolCall(call);
      if (invalid) {
        emitToolResult(toolEventId, invalid.result, invalid.reason);
        return {
          ok: false,
          call,
          result: invalid.result,
          contextOutput: invalid.reason,
        };
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

      const guard = evaluateToolGuards({
        call,
        narrowNmapOperation,
        narrowNmapDispatched: narrowNmapDispatchCount,
        heldBatchReminder:
          call.name === "task.update" && batchRemindCalls.has(rawCall)
            ? batchReminderNote
            : undefined,
      });
      if (guard.kind === "reject") {
        const result = { ok: false, output: guard.reason, exitCode: 1 };
        emitToolResult(toolEventId, result, guard.reason);
        return { ok: false, call, result, contextOutput: guard.reason };
      }
      if (guard.kind === "hold") {
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(toolEventId, call);
          alreadyPrintedIds.add(toolEventId);
        }
        const result = { ok: false, output: guard.reason, exitCode: 1 };
        emitToolResult(toolEventId, result, guard.reason);
        writeToolOutput(toolEventId, "held\n");
        return { ok: false, call, result, contextOutput: guard.reason };
      }
      if (guard.kind === "proceed" && guard.consumesNarrowNmapScan) {
        narrowNmapDispatchCount += 1;
      }

      const retryReason = readRetryReason(call.args);
      const currentProbeState = probeStateKey(call);
      const loopCheck = loopGuard.shouldBlock(call.name, call.args, {
        dependenciesChanged: retryDependenciesChanged,
        environmentChanged: retryEnvironmentChanged,
        ...(currentProbeState ? { stateKey: currentProbeState } : {}),
        ...(retryReason ? { retryReason } : {}),
      });
      const loopDecision = evaluateLoopGuardBlock(call, {
        verdict: loopCheck,
        priorObservation:
          loopCheck.kind === "unchanged-success"
            ? loopGuard.getPriorObservation(call.name, call.args)
            : undefined,
      });
      if (loopDecision.kind === "reuse") {
        const result: ToolResult = {
          ok: true,
          output: loopDecision.reason,
          exitCode: 0,
        };
        emitVisibleSyntheticReceipt(result, loopDecision.reason);
        return {
          ok: true,
          call,
          result,
          contextOutput: loopDecision.reason,
          suppressedRepeat: true,
        };
      }
      if (loopDecision.kind === "warn-reject") {
        writeNotice("warn", loopDecision.reason);
        const result = { ok: false, output: loopDecision.reason, exitCode: 1 };
        emitToolResult(toolEventId, result, loopDecision.reason);
        return { ok: false, call, result, contextOutput: loopDecision.reason };
      }

      if (call.name === "loop.reset") {
        loopGuard.resetAllSequenceCounts();
        const output = LOOP_RESET_OUTPUT;
        const result: ToolResult = { ok: true, output, exitCode: 0 };
        emitVisibleSyntheticReceipt(result, output);
        loopGuard.recordAttempt(step, call.name, call.args, true, 0, output);
        return { ok: true, call, result, contextOutput: output };
      }

      if (mcpRuntime && MCP_AGENT_TOOL_NAMES.has(call.name)) {
        return executeMcpAgentCall(mcpRuntime, call, toolEventId);
      }

      if (RUNNER_META_TOOL_NAMES.has(call.name)) {
        if (call.name === "job.read" || call.name === "task.read") {
          const readRequest = parseResponderReadRequest(call.name, call.args);
          const readDecision = decideResponderRead(
            readRequest,
            {
              wakeTurn: responderWakeTurn,
              notificationId: responderWakeNotificationId,
              jobId: responderWakeJobId,
              resultRevision: responderWakeResultRevision,
            },
            {
              pendingNotifications: jobManager.getPendingNotifications(
                session.sessionId,
              ),
              matchesWakeRevision,
              isClaimed: (id) => responderClaims.has(id),
              markRead: (id) => jobManager.markRead(id, session.sessionId),
            },
          );
          const marked = readDecision.marked;
          const output = readDecision.output;
          if (readDecision.ledgerNotification) {
            deferredResponderLedgerNotifications.push(
              readDecision.ledgerNotification,
            );
          }
          if (readDecision.releaseClaimId) {
            responderClaims.delete(readDecision.releaseClaimId);
          }
          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(toolEventId, call);
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

        if (call.name === "task.update") {
          const updateRequest = parseTaskUpdateRequest(call.args);
          if (updateRequest.state === "done" && updateRequest.taskId) {
            const live = await loadPlan(session.sessionId).catch(() => undefined);
            const resolved =
              (live ? resolvePlanTaskId(live, updateRequest.taskId) : undefined) ??
              updateRequest.taskId;
            const gate = decideTaskUpdateDoneGate(live, resolved, (livePlan, id) =>
              completionGateForTask(livePlan, id),
            );
            if (!gate.ok) {
              writeNotice("warn", gate.reason);
              if (!alreadyPrintedIds.has(toolEventId)) {
                writeToolCall(toolEventId, call);
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
            await applyTaskUpdateLedgerTransition(
              {
                getLedger: () => taskWorkLedger,
                setLedger: (ledger) => {
                  taskWorkLedger = ledger;
                },
                looseWork: () => sessionLooseWork,
                persistTaskEvidence,
              },
              call,
              planResult.plan,
            );
          }

          if (planResult.ok && planResult.plan) {
            // Keep the batch-end SESSION STATE aligned with successful plan
            // transitions. Otherwise a completed task can still appear open
            // on the next model round and trigger duplicate work.
            pendingSessionStatePlan = planResult.plan;
          }

          if (!alreadyPrintedIds.has(toolEventId)) {
            writeToolCall(toolEventId, call);
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

      const scope = await loadScopeForSession(session.sessionId);
      const decision =
        mcpRuntime?.classify(call.name) ?? classifyToolCall(call, { scope });
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
      const planModeGate = decidePlanModeGate({
        call,
        isPlanMode,
        planApproved: session.planApproved.value,
        scratchDir,
        mcpSafe: mcpRuntime?.classify(call.name)?.level === "safe",
      });
      if (planModeGate.blocked) {
        const reason = planModeGate.reason;
        writeNotice("warn", reason);
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(toolEventId, call);
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
          await autostartPlanTask(livePlanForGate, call, {
            openTask: async (taskId) => {
              await mutatePlan(session.sessionId, (draft) => {
                const target = draft.tasks.find(
                  (candidate) => candidate.id === taskId,
                );
                if (!target || target.state === "in_progress") return false;
                target.state = "in_progress";
                if (draft.status === "draft" || draft.status === "approved") {
                  draft.status = "in_progress";
                }
                return true;
              }).catch(() => undefined);
            },
            renderPlan: writePlanUpdate,
            notify: (message) => writeNotice("info", message),
            getLedger: () => taskWorkLedger,
            setLedger: (ledger) => {
              taskWorkLedger = ledger;
            },
          });
        }
      }

      call = applyDestinationCwd(
        call,
        destinationHint ?? getActiveProjectRoot(),
      );

      const scaffoldPreflight = decideScaffoldPreflight(call);
      if (scaffoldPreflight.skip) {
        if (
          scaffoldPreflight.adoptTarget &&
          scaffoldPreflight.target &&
          setActiveProjectRootIfValid(scaffoldPreflight.target, { force: true })
        ) {
          await persistProjectRootOnPlan(scaffoldPreflight.target);
        }
        const message = scaffoldPreflight.message;
        writeNotice("info", message);
        if (!alreadyPrintedIds.has(toolEventId)) {
          writeToolCall(toolEventId, call);
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

      const authorization = await authorizeToolExecution(
        {
          call,
          toolEventId,
          parentSignal,
          level: decision.level,
          reason: decision.reason,
        },
        {
          autoConfirm: Boolean(options.autoConfirm),
          session,
          confirmPort,
          acquirePrompt: () => promptMutex.acquire(),
          writeToolBlocked,
          emitToolResult,
        },
      );
      if (authorization.kind === "stop") return authorization.result;

      parentSignal.throwIfAborted();
      const planAtDispatch = await loadPlan(session.sessionId).catch(
        () => undefined,
      );
      const dispatch = await resolveToolDispatch(
        {
          mutatePlan: (mutator) => mutatePlan(session.sessionId, mutator),
          renderPlan: writePlanUpdate,
          setPendingSessionStatePlan: (plan) => {
            pendingSessionStatePlan = plan;
          },
          notify: writeNotice,
          getLedger: () => taskWorkLedger,
          setLedger: (ledger) => {
            taskWorkLedger = ledger;
          },
        },
        call,
        planAtDispatch,
      );
      if (dispatch.kind === "reject") {
        const result = { ok: false, output: dispatch.reason, exitCode: 1 };
        emitToolResult(toolEventId, result, dispatch.reason);
        return { ok: false, call, result, contextOutput: dispatch.reason };
      }
      dispatchedTaskId = dispatch.dispatchedTaskId;
      delegation = dispatch.delegation;

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


      const watchdog = createToolWatchdog({
        toolName: call.name,
        stallBudgetMs: toolStallBudgetMs(call),
        hardBudgetMs: toolHardBudgetMs(call),
        graceMs: TOOL_ABORT_GRACE_MS,
        controller: toolAc,
        notify: (message) => writeNotice("warn", message),
      });
      watchdog.resetStallTimer();

      const engagementRunOptions =
        engagementAction && scope
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
            : {};

      const startToolWork = (): Promise<ToolResult> =>
          mcpRuntime !== undefined &&
          (mcpRuntime.getTool(call.name) !== undefined ||
            isCanonicalToolName(call.name))
            ? mcpRuntime.callTool(call.name, call.args, { signal: toolAc.signal })
            : runToolCall(call, {
          signal: toolAc.signal,
          requestSecret: options.requestSecret ?? stdioSecretRequester,
          onOutput: (chunk) => {
            if (toolAc.signal.aborted) return;
            watchdog.resetStallTimer();
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
          ...engagementRunOptions,
        });

      const supervised = await superviseToolExecution(
        {
          watchdog,
          parentSignal,
          toolSignal: toolAc.signal,
          isAbortError,
          liveBytes: () => liveBytes,
          writeToolOutput: (chunk) => writeToolOutput(toolEventId, chunk),
          updateJobStatus: (status, exitCode) =>
            jobManager.updateJobStatus(jobId, status, exitCode),
          cleanup: () => {
            watchdog.dispose();
            engagementLease?.release();
            parentSignal.removeEventListener("abort", onParentAbort);
          },
        },
        startToolWork,
      );
      result = supervised.result;
      if (supervised.kind === "cancelled") {
        emitToolResult(toolEventId, result, result.output);
        return {
          ok: false,
          call,
          result,
          contextOutput: result.output,
          aborted: true,
        };
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

      const scaffoldOutcome = reconcileScaffoldOutcome(call, result);
      result = scaffoldOutcome.result;
      if (scaffoldOutcome.adoptRoot) {
        setActiveProjectRootIfValid(scaffoldOutcome.adoptRoot, { force: true });
        await persistProjectRootOnPlan(scaffoldOutcome.adoptRoot);
      }
      if (scaffoldOutcome.notice) {
        writeNotice("info", scaffoldOutcome.notice);
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
        if (durableJob?.responder) {
          result = await linkResponderJobToPlan(
            {
              loadPlan: () =>
                loadPlan(session.sessionId).catch(() => undefined),
              mutatePlan: (mutator) => mutatePlan(session.sessionId, mutator),
              linkJob: (jobIdToLink, patch) =>
                jobManager.linkJob(jobIdToLink, patch),
              renderPlan: writePlanUpdate,
              setPendingSessionStatePlan: (plan) => {
                pendingSessionStatePlan = plan;
              },
              notify: writeNotice,
            },
            {
              job: durableJob,
              call,
              toolEventId,
              delegationTaskId: delegation?.taskId,
              dispatchedTaskId,
            },
            result,
          );
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
      const accountingState = {
        retryDependenciesChanged,
        retryEnvironmentChanged,
        governorState,
      };
      accountToolOutcome(
        {
          outcomeState,
          maxSteps,
          codingSession,
          attemptCount: (attemptedCall) =>
            loopGuard.getAttemptCount(attemptedCall.name, attemptedCall.args),
          moveTurn,
          deferMessage: (message) => deferredPostToolMessages.push(message),
        },
        accountingState,
        {
          call,
          result,
          toolEventId,
          artifactPath: savedOutputPath,
          dispatchedTaskId,
          probeStateKey: completedProbeState,
        },
      );
      retryDependenciesChanged = accountingState.retryDependenciesChanged;
      retryEnvironmentChanged = accountingState.retryEnvironmentChanged;
      governorState = accountingState.governorState;
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
        const signals = readTaskWorkSignals(call, result.output ?? "");
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
    const compactionExecutionState: CompactionExecutionState = {};
    /**
     * The last successful main request exactly as dispatched. A compaction
     * that replays it (plus the messages appended since) keeps the entire
     * prior prompt as a strict prefix, so APC providers serve the compaction
     * request from cache instead of re-billing the whole context.
     */
    let lastSuccessfulRequestSnapshot: SuccessfulRequestSnapshot | undefined =
      options.previousSuccessfulRequest;
    /**
     * Per-attempt replay decision made by maybeAutoCompact and read by
     * summarizeForCompaction. When undefined the legacy transcript-rendered
     * requests are used (no snapshot yet, or the replay would not fit).
     */
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

    const summarizeForCompaction = createCompactionSummarizer({
      provider,
      model,
      signal: options.signal,
      history: messages,
      state: compactionExecutionState,
      currentContextLimitTokens,
      toolsForSourceMessages: () =>
        selectToolDefs(nativeToolsActive, useCompactSystemPrompt),
      writeDelta: writeCompactionDelta,
    });

    const estimateNextRequestTokens = createCompactionRequestEstimator({
      provider,
      model,
      selectTools: () => {
        const { native } = resolveNativeTools(provider, model);
        return selectToolDefs(native, useCompactSystemPrompt);
      },
    });

    const buildTurnDurableEnvelope =
      createCompactionDurableEnvelopeBuilder({
        messages,
        outcome: outcomeState,
        ledger: workLedger,
        loadPlan: () => loadPlan(session.sessionId),
        getProjectRoot: getActiveProjectRoot,
        detectPackageManager,
        getUnreadNotificationIds: () =>
          jobManager
            .getPendingNotifications(session.sessionId)
            .map((notification) => notification.id),
        getRunningJobs: () => jobManager.getRunningJobs(session.sessionId),
        getRecentJobs: () => jobManager.getRecentJobs(12, session.sessionId),
      });

    const maybeAutoCompact = createCompactionCoordinator({
      messages,
      provider: () => provider,
      model: () => model,
      dialect: () => toolDialect,
      keepRecent: AUTO_COMPACT_KEEP_RECENT,
      contextLimitTokens: currentContextLimitTokens,
      estimateRequestTokens: estimateNextRequestTokens,
      selectTools: () =>
        selectToolDefs(nativeToolsActive, useCompactSystemPrompt),
      buildDurableEnvelope: buildTurnDurableEnvelope,
      attempts: {
        isSuppressed: (key) => compactionAttempts.isSuppressed(key),
        recordFailure: (key) => compactionAttempts.recordFailure(key),
        recordSuccess: (key) => compactionAttempts.recordSuccess(key),
      },
      executionState: compactionExecutionState,
      newCompactionId: () => `compact-${randomUUID().slice(0, 12)}`,
      lastSuccessfulRequestSnapshot: () => lastSuccessfulRequestSnapshot,
      clearSuccessfulRequestSnapshot: () => {
        lastSuccessfulRequestSnapshot = undefined;
      },
      summarize: summarizeForCompaction,
      loadPlan: () => loadPlan(session.sessionId).catch(() => undefined),
      instructionsBlock: () => agentInstructionsBlock,
      skillsBlock: () => activeSkillsBlock,
      planApproved: () => session.planApproved.value,
      resetReadOnlyGuard: () => loopGuard.resetReadOnly(),
      refreshSessionState: (plan) => refreshSessionState(plan),
      setLastCompactionMsgCount: (count) => {
        lastCompactionMsgCount = count;
      },
      writeStarted: writeCompactionStarted,
      writeFailed: writeCompactionFailed,
      writeCompleted: writeCompactionCompleted,
      notify: writeNotice,
      audit: (event, payload) => {
        void auditLog(event, payload);
      },
    });

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {

      outputState.visibleCommitted = false;
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
        const streamSession = createStreamSession({
          emitStatus: (text) => emit({ type: "status", text }),
          emitAssistantDelta: (text) => emit({ type: "assistant-delta", text }),
          emitThinkingDelta: (text) => emit({ type: "thinking-delta", text }),
          writeStatus,
          notify: writeNotice,
          writeToolCall,
          nextToolEventId: () => `tool-${++nextToolEventId}`,
          markPrinted: (eventId) => alreadyPrintedIds.add(eventId),
          nativeToolsAttached: () => toolsAttached,
          onSuccessfulRequest: (snapshot) => {
            lastSuccessfulRequestSnapshot = snapshot;
            options.onSuccessfulRequest?.(snapshot);
          },
        });
        const deferredToolCalls = streamSession.deferredToolCalls;
        const streamedNativeCallNames = streamSession.streamedNativeCallNames;
        const callIds = streamSession.callIds;
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
          const assemblyState: RequestAssemblyState = {
            freeTierLargeContextWarned,
            freeTierConsecutiveFailures,
            truncatedBudgetRounds,
            continuationBudgetFloor,
            retryWithoutThinking,
          };
          const contextLimitTokens = currentContextLimitTokens();
          let estimatedInputTokens = 0;
          try {
          const assembled = await assembleRequest(
            {
              messages,
              provider,
              model,
              dialect: toolDialect,
              nativeToolsActive,
              thinking: config.thinking,
              step,
              contextLimitTokens,
              estimateRequestTokens: estimateNextRequestTokens,
              selectTools: () =>
                selectToolDefs(nativeToolsActive, useCompactSystemPrompt),
              notify: writeNotice,
              emitContextEstimate: (estimatedTokens) =>
                emit({ type: "context-estimate", estimatedTokens, model }),
              audit: (event, payload) => auditLog(event, payload),
            },
            assemblyState,
          );
          freeTierLargeContextWarned = assemblyState.freeTierLargeContextWarned;
          const turnTools = assembled.tools;
          toolsAttached = assembled.toolsAttached;
          estimatedInputTokens = assembled.estimatedInputTokens;
          stepMaxTokens = assembled.stepMaxTokens;
          dispatchedRawRequestTokens = assembled.rawRequestTokens;
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
                  onToolCallDelta: streamSession.onToolCallDelta,
                }
                : {}),
            },
            streamSession.onToken,
            {
              onStatus: streamSession.onStatus,
              onStreamEvent: streamSession.onStreamEvent,
              onSuccessfulRequest: streamSession.onSuccessfulRequest,
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
            // A blocked over-limit request is a policy stop, not a route
            // failure — retrying it would just re-bill the same doomed prefix.
            if (streamError instanceof RequestOverLimitError) throw streamError;

            const failedOperationUsage = operationUsageFromError(streamError);
            const failedAttempt = failedOperationUsage?.attempts.at(-1);
            const failedUsage = failedOperationUsage?.aggregate.usage;
            const failureState: StreamFailureState = {
              freeTierConsecutiveFailures,
              freeTierAdvisoryShown,
              lowYieldResumptions,
              interruptedVisible,
              interruptedReasoning,
              allowModelFallback,
              preferModelFallback,
              retryWithoutThinking,
              visibleCommitted: outputState.visibleCommitted,
            };
            const decision = await recoverFromStreamFailure(
              {
                messages,
                recoveryState,
                provider,
                estimatedInputTokens,
                notify: writeNotice,
                emitStatus: (text) => emit({ type: "status", text }),
                emitTokenUsage: (usage, usageProvider, usageModel) =>
                  emit({
                    type: "token-usage",
                    usage,
                    model: usageModel,
                    provider: usageProvider,
                  }),
                emitEmptyAssistantMessage: () =>
                  emit({ type: "assistant-message", text: "" }),
                writeAssistantMessage,
                writeThinkingBlock,
                writeToolBlocked,
                rememberThinking,
                sanitizeAssistantText,
                finishDeltaParser: streamSession.finishDeltaParser,
                recoveryUserMessage,
                forceCompact: (reason) => maybeAutoCompact(reason, true),
                delay: (ms) => delay(ms, options.signal),
              },
              failureState,
              {
                kind: classifyStreamFailure(streamError),
                alreadyEmitted: streamAlreadyEmitted(streamError),
                attemptUsage:
                  failedUsage && failedAttempt
                    ? {
                      usage: failedUsage,
                      provider: failedAttempt.provider,
                      model: failedAttempt.model,
                    }
                    : undefined,
                accumulatedText: streamSession.accumulatedText(),
                streamedReasoningText: streamSession.streamedReasoningText(),
                deferredToolCalls,
              },
            );
            freeTierConsecutiveFailures = failureState.freeTierConsecutiveFailures;
            freeTierAdvisoryShown = failureState.freeTierAdvisoryShown;
            lowYieldResumptions = failureState.lowYieldResumptions;
            interruptedVisible = failureState.interruptedVisible;
            interruptedReasoning = failureState.interruptedReasoning;
            allowModelFallback = failureState.allowModelFallback;
            preferModelFallback = failureState.preferModelFallback;
            retryWithoutThinking = failureState.retryWithoutThinking;
            outputState.visibleCommitted = failureState.visibleCommitted;
            if (decision === "rethrow") throw streamError;
            continue;
          }
        } finally {
          streamSession.stopHeartbeat();
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
        await accountCompletionUsage(
          {
            dispatchedRawRequestTokens,
            emitTokenUsage: ({ usage, provider: usageProvider, model: usageModel, attempt }) =>
              emit({
                type: "token-usage",
                usage,
                model: usageModel,
                provider: usageProvider,
                ...(attempt ? { attempt } : {}),
              }),
            audit: (event, payload) => auditLog(event, payload),
          },
          completion,
        );
        streamSession.finishDeltaParser();
        // Sticky text-only may have flipped dialect during stream retry.
        ({ dialect: toolDialect, native: nativeToolsActive } =
          resolveNativeTools(provider, model));
        // toolsAttached may have been true for the request; if sticky
        // fallback dropped tools, treat as text mode for this turn's parse.
        const usedNativeProtocol = Boolean(completion.toolCalls?.length) ||
          (toolsAttached && !isTextOnlyModel(provider, model));

        const interpreted = interpretCompletion({
          completion,
          streamedReasoningText: streamSession.streamedReasoningText(),
          interruptedVisible,
        });
        if (interpreted.thinkContent) rememberThinking(interpreted.thinkContent);
        canonicalAssistantVisible = interpreted.canonicalVisible;
        assistantText = interpreted.assistantText;
        const retryReasoning = interpreted.retryReasoning;
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
          pushAssistantHistory(historyText, retryReasoning);
          interruptedVisible = "";
          interruptedReasoning = "";
          lowYieldResumptions = 0;
        };


        // Native-first: prefer structured toolCalls from the provider.
        let nativeToolCalls: NativeToolCall[] = completion.toolCalls ?? [];
        // Early UI cards: refresh args if stream deltas already opened cards;
        // otherwise create cards now (non-streaming / name-after-done providers).
        syncNativeToolCallCards(
          {
            deferredToolCalls,
            callIds,
            allocateEventId: () => `tool-${++nextToolEventId}`,
            markPrinted: (eventId) => alreadyPrintedIds.add(eventId),
          },
          nativeToolCalls,
        );

        if (nativeToolCalls.length) {
          call = firstNativeToolCall(nativeToolCalls);
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
          truncatedToolRetries += hasTruncatedNativeWrite(nativeToolCalls) ? 1 : 0;
          if (truncatedToolRetries <= 5) {
            const salvagedNative = await salvageTruncatedNativeWrite(
              {
                messages,
                toolsAttached,
                notify: writeNotice,
                applySalvagedWrite,
              },
              {
                nativeToolCalls,
                assistantVisible: assistantText.visible,
                assistantThinkContent: assistantText.thinkContent,
                hasThinking: assistantText.hasThinking,
                completion,
              },
            );
            if (salvagedNative) {
              nativeToolCalls = [];
              call = undefined;
              deferredToolCalls.length = 0;
              continue;
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


        const completionBudget = routeCompletionBudget({
          provider,
          model,
          stepMaxTokens,
        });
        const hitOutputLimit = outputBudgetExhausted({
          completion,
          completionBudget,
        });
        const incompleteNativeStream =
          nativeToolCalls.length === 0 && streamedNativeCallNames.size > 0;
        const outputLimitLooksLikeTool =
          incompleteNativeStream ||
          countToolFences(assistantText.visible) > 0 ||
          looksLikeTruncatedToolCall(assistantText.visible);
        if (hitOutputLimit && !call && !outputLimitLooksLikeTool) {
          const budgetState: OutputBudgetState = {
            truncatedBudgetRounds,
            continuationBudgetFloor,
            retryWithoutThinking,
            interruptedVisible,
            interruptedReasoning,
            lowYieldResumptions,
            visibleCommitted: outputState.visibleCommitted,
          };
          const budgetDecision = handleOutputBudgetExhaustion(
            {
              messages,
              provider,
              model,
              stepMaxTokens,
              maxStepCompletionTokens: MAX_STEP_COMPLETION_TOKENS,
              notify: writeNotice,
              recoveryUserMessage,
              pushAssistantHistory: (historyText) =>
                pushAssistantHistory(historyText, retryReasoning),
              commitAssistantRetry,
            },
            budgetState,
            {
              completion,
              assistantVisible: assistantText.visible,
              assistantThinkContent: assistantText.thinkContent,
              hasThinking: assistantText.hasThinking,
              canonicalVisible: canonicalAssistantVisible,
            },
            completionBudget,
          );
          truncatedBudgetRounds = budgetState.truncatedBudgetRounds;
          continuationBudgetFloor = budgetState.continuationBudgetFloor;
          retryWithoutThinking = budgetState.retryWithoutThinking;
          interruptedVisible = budgetState.interruptedVisible;
          interruptedReasoning = budgetState.interruptedReasoning;
          lowYieldResumptions = budgetState.lowYieldResumptions;
          outputState.visibleCommitted = budgetState.visibleCommitted;
          if (budgetDecision === "continue-round") continue;
          if (budgetDecision === "stop-partial") {
            return finishTurn(
              "The model exhausted its output budget again after one preserved continuation. No visible answer was produced.",
              step + 1,
              "partial",
              ["Retry at a lower reasoning effort or choose a model with a larger output limit."],
              "The model exhausted the route's output budget twice without a visible answer.",
            );
          }
        }

        if (!canonicalAssistantVisible.trim() && !call) {
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
          const emptyState: EmptyResponseState = {
            emptyVisibleRetries,
            retryWithoutThinking,
            interruptedReasoning,
          };
          const emptyDecision = handleEmptyResponse(
            {
              messages,
              toolsAttached,
              planModeWithoutPlan: isPlanMode && !activePlan,
              notify: writeNotice,
              commitAssistantRetry,
              recoveryUserMessage,
            },
            emptyState,
            {
              assistantVisible: assistantText.visible,
              assistantThinkContent: assistantText.thinkContent,
              hasThinking: assistantText.hasThinking,
              incompleteNativeStream,
            },
          );
          emptyVisibleRetries = emptyState.emptyVisibleRetries;
          retryWithoutThinking = emptyState.retryWithoutThinking;
          interruptedReasoning = emptyState.interruptedReasoning;
          if (emptyDecision === "continue-round") continue;
          return finishTurn("Model returned an empty response after retries.", step + 1);
        } else {
          // Reset the counter on any successful visible output or recovered call.
          emptyVisibleRetries = 0;
          truncatedBudgetRounds = 0;
          continuationBudgetFloor = 0;
          retryWithoutThinking = false;
          interruptedReasoning = "";
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
          const recoveryLadderState = {
            bareToolJsonRetries,
            truncatedToolRetries,
            malformedFenceRetries,
          };
          const recoveryDecision = await recoverMissingToolCall(
            {
              messages,
              toolsAttached,
              planModeWithoutPlan: isPlanMode && !activePlan,
              notify: writeNotice,
              commitAssistantRetry,
              recoveryUserMessage,
              applySalvagedWrite,
            },
            recoveryLadderState,
            { visible: assistantText.visible, bareArgsOnly },
          );
          bareToolJsonRetries = recoveryLadderState.bareToolJsonRetries;
          truncatedToolRetries = recoveryLadderState.truncatedToolRetries;
          malformedFenceRetries = recoveryLadderState.malformedFenceRetries;
          if (recoveryDecision === "retry") continue;

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
            responderClaims.size > 0;
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
            const unread = responderClaims.ids();
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
          const finalOutcome = await resolveFinalOutcome(
            {
              outcomeState,
              planApproved: session.planApproved.value,
              loadPlan: () =>
                loadPlan(session.sessionId).catch(() => undefined),
              saveOutcomeState,
            },
            cleaned,
          );
          const outcomeStatus = finalOutcome.status;
          const remainingCriteria = finalOutcome.remainingCriteria;
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
            finalOutcome.reason,
            interruptedVisible ? cleaned : displayCleaned,
          );
        }

        // A valid primary tool call exists for this fresh model turn. Show any
        // prose / thinking that preceded it, record the assistant message ONCE.
        const toolDisplayText = interruptedVisible
          ? canonicalAssistantVisible
          : assistantText.visible;
        const beforeTool = recoveredFromBareJson
          ? ""
          : nativeToolCalls.length
            ? toolDisplayText.trim()
            : textBeforeToolCall(toolDisplayText);
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
          wireId?: string | undefined;
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
            return { index, id: tc.id, call, native: tc, wireId: tc.id };
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
          const suppression = suppressRepeatedActionSequence(
            {
              messages,
              notify: writeNotice,
              queuedEventId: (index) => deferredToolCalls[index]?.eventId,
              allocateEventId: () => `tool-${++nextToolEventId}`,
              writeToolCall,
              markPrinted: (eventId) => alreadyPrintedIds.add(eventId),
              emitToolStart: (eventId) =>
                emit({ type: "tool-start", id: eventId }),
              writeToolOutput: (eventId, chunk) =>
                writeToolOutput(eventId, chunk),
              emitToolResult,
              priorObservation: (priorCall) =>
                loopGuard.getPriorObservation(priorCall.name, priorCall.args),
              pushAssistantHistory: (text) =>
                pushAssistantHistory(text, completion),
              upsertActionCycleRecovery,
              unreadResponderResults: () => responderClaims.size > 0,
              currentSignature: () =>
                loopGuard.currentActionSequenceSignature(),
            },
            {
              verdict: sequenceDecision,
              bound,
              runIds,
              deferReason,
              beforeTool,
              historyNativeCalls,
              completion,
              assistantThinkContent: assistantText.thinkContent,
              hasThinking: assistantText.hasThinking,
            },
          );
          if (suppression.kind === "stop") {
            outcomeState.outcome.status = "partial";
            await saveOutcomeState(outcomeState);
            moveTurn("partial", "repeated identical action sequence");
            return finishTurn(
              suppression.answer,
              productiveSteps,
              "partial",
              suppression.remainingCriteria,
              suppression.reason,
              undefined,
              suppression.loopGuardStop,
            );
          }
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
          }
          if (!deferred.shown || stale) {
            writeToolCall(deferred.eventId, deferred.call);
            deferred.shown = true;
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
            completion.reasoningArtifacts,
          );
        } else {
          const standardizedContent =
            (beforeTool ? beforeTool.trim() + "\n\n" : "") +
            allCalls
              .map((c) => `\`\`\`tool\n${JSON.stringify(c)}\n\`\`\``)
              .join("\n\n");
          pushAssistantHistory(standardizedContent, completion);
        }


        const scopeForBatch = await loadScopeForSession(session.sessionId).catch(
          () => undefined,
        );

        const isParallelSafe = (c: ToolCall): boolean => {
          if (mcpRuntime?.isParallelSafe(c.name)) return true;
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
        const toolResultRecorder = createToolResultRecorder({
          messages,
          useNativeToolHistory: historyNativeCalls.length > 0,
          deferredPostToolMessages,
          seenHashes: toolResultHashes,
          remindedAt: planRemindedAt,
          writeNotice,
        });
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
          toolResultRecorder.record({
            id: boundCall.id,
            call: res.call,
            result: res.result,
            contextOutput: res.contextOutput,
            isPlanMode,
            planApproved: session.planApproved.value,
            hasDraftPlan: planCreatedThisTurn,
            productiveStep: productiveSteps,
            kindHint:
              activePlan?.kind === "pentest" || pentestLikeTurn
                ? "pentest"
                : activePlan?.kind === "coding"
                  ? "coding"
                  : "general",
          });
          // Reset retry counters — they track consecutive failures, not cumulative.
          truncatedToolRetries = 0;
          malformedFenceRetries = 0;
          bareToolJsonRetries = 0;

          const evidence = readToolEvidenceSignals({
            call: res.call,
            ok: res.ok,
            output: res.result.output ?? res.contextOutput ?? "",
            pentestTurn: pentestLike || pentestSession,
            activeProjectRoot: getActiveProjectRoot(),
          });
          if (evidence.mutationLanded) sawSuccessfulMutation = true;
          if (evidence.freshProbeFailure) sawSuccessfulMutation = false;
          if (evidence.evidenceWorkTool) {
            recovery.actionIntent = 0;
            recovery.errorFix = 0;
          }
          if (evidence.serverStarted) sawServerStart = true;
          if (evidence.serverTailed) sawServerTail = true;
          if (evidence.activePentestTest) sawActivePentestTest = true;
          if (evidence.localProbe === "failure") {
            sawFailedLocalHttpProbe = true;
            sawLocalHttpProbe = false;
          } else if (evidence.localProbe === "success") {
            sawLocalHttpProbe = true;
            sawFailedLocalHttpProbe = false;
            recovery.failedProbe = 0;
          } else if (evidence.localProbe === "softSuccess") {
            sawLocalHttpProbe = true;
            sawFailedLocalHttpProbe = false;
          }
          if (evidence.scaffoldCreated) sawScaffoldOk = true;
          if (evidence.featureWrite) sawFeatureImplWrite = true;
          if (evidence.localAppMaterialWork) sawLocalAppMaterialWork = true;
          if (res.call.name === "instructions.record" && res.ok) {
            instructionsChangedThisRound = true;
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
        {
          const livePlanForBatch = await loadPlan(session.sessionId).catch(
            () => undefined,
          );
          const guard = evaluateTaskBatchGuard({
            calls: toRun.map((bound) => bound.call),
            plan: livePlanForBatch,
            pendingSignature: session.pendingTaskBatch.value,
          });
          batchRemindCalls = new Set<ToolCall>(guard.remindCalls);
          batchReminderNote = guard.reminderNote;
          session.pendingTaskBatch.value = guard.pendingSignature;
          for (const notice of guard.notices) {
            writeNotice(notice.level, notice.message);
          }
        }

        const replayExecutedOccurrence = (
          bc: BoundCall,
          uiId: string,
        ): ReplayedOccurrence | undefined =>
          wireOccurrences.replay(bc.wireId, bc.call, uiId);
        const rememberExecutedOccurrence = (
          bc: BoundCall,
          res: {
            call: ToolCall;
            result: ToolResult;
            contextOutput: string;
            ok: boolean;
            aborted?: boolean | undefined;
            suppressedRepeat?: boolean | undefined;
          },
        ): void => wireOccurrences.remember(bc.wireId, res);

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
            const replayed = replayExecutedOccurrence(bc, id);
            if (replayed) {
              recordResult(bc, replayed);
              continue;
            }
            const res = await executeSingleTool(
              call,
              id,
              options.signal || new AbortController().signal,
            );
            recordResult(bc, res);
            rememberExecutedOccurrence(bc, res);
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
              groupBound.map((bc, k) => {
                const replayed = replayExecutedOccurrence(bc, uiIds[k]!);
                if (replayed) return replayed;
                return executeSingleTool(
                  bc.call,
                  uiIds[k]!,
                  options.signal || new AbortController().signal,
                );
              }),
            );
            for (let k = 0; k < results.length; k += 1) {
              recordResult(groupBound[k]!, results[k]!);
              rememberExecutedOccurrence(groupBound[k]!, results[k]!);
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

        if (instructionsChangedThisRound) {
          instructionsChangedThisRound = false;
          await refreshAgentInstructions();
        }

        // SESSION STATE only after the assistant→tool group is closed.
        // Mid-group upserts were the root cause of "No stored body" thrash.
        refreshSessionState(pendingSessionStatePlan);

        if (
          responderWakeTurn &&
          responderClaims.size > 0 &&
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
    responderClaims.release();
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
  } finally {
    mcpLease?.release();
  }
}

/** Compatibility boundary for callers that consume visible assistant text. */
export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  return (await runAgentTurn(prompt, options)).answer;
}
