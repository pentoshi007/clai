import type { McpRuntime, McpTurnLease } from "../mcp/runtime.js";
import { hasMcpMentionSyntax } from "../mcp/mentions.js";
import type {
  ChatMessage,
  ChatImage,
  Mode,
  ProviderId,
  SuccessfulRequestSnapshot,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "../types.js";
import { providerInputTokenBudget } from "../llm/context-windows.js";
import {
  createStreamRecoveryState,
} from "./stream-recovery.js";
import type {
  SingleToolResult,
  TurnEventPort,
  TurnOutputState,
} from "./turn/contracts.js";
import { finalizeTurn } from "./turn/finalizer.js";
import { assembleTurnMessages } from "./turn/message-assembly.js";
import {
  createTurnEvidenceFlags,
} from "./turn/evidence-flags.js";
import {
  createWireOccurrenceLedger,
} from "./turn/loop/wire-occurrences.js";
import {
  createPromptMutex,
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
import { ResponderClaimLedger } from "./turn/responder-claims.js";
import { buildPromptSections } from "./turn/prompt-sections.js";
import { buildSystemSections } from "./turn/system-sections.js";
import { createToolRouting } from "./turn/tool-routing.js";
import { runSingleTool } from "./turn/tool-execution/single-tool.js";
import { runTurnRounds } from "./turn/loop/run-rounds.js";
import type { TurnLoopDeps } from "./turn/loop/deps.js";
import type { SingleToolDeps } from "./turn/tool-execution/deps.js";
import { createToolExecutionState } from "./turn/tool-execution/state.js";
import type { TurnLoopState } from "./turn/loop/state.js";
import {
  createTurnCounters,
} from "./turn/turn-counters.js";
import { createCompactionServices } from "./turn/setup/compaction-services.js";
import { createTurnHistoryWriter } from "./turn/history-writer.js";
import { shouldYieldForDeclaredResponderDependency as declaredResponderDependencyYields } from "./turn/responder-dependency.js";
import {
  loadTurnInstructions,
  orientTurnWorkspace,
} from "./turn/workspace-setup.js";
import {
  evaluateTaskCompletionGate,
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
  type CompactionExecutionState,
} from "./turn/compaction-summarizer.js";
import {
  type ToolCallingMode,
} from "../llm/tool-protocol.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../ui-core/rendering/sanitize-display.js";
import {
  jobManager,
  type BackgroundJob,
  type ResponderNotification,
} from "../tools/jobs.js";
import {
  scratchDirFor,
} from "../prompts/index.js";
import { getConfig, getProviderModel } from "../store/config.js";
import {
  beginSessionWorkspace,
  getActiveSessionWorkspace,
} from "../store/session-workspace.js";
import {
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
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import {
  upsertActiveSkillsMessage,
  upsertAgentInstructionsMessage,
} from "./injected-blocks.js";
import { getSkillIndex } from "../skills/registry.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { safeCwd } from "../os/cwd.js";
import {
  analyzeTask,
  isNarrowExplicitNmapOperation,
} from "./task-analyzer.js";
import { computeMaxIterations, computeStepBudget } from "./step-budget.js";
import { WorkLedger } from "./durable-envelope.js";
import { LoopGuard } from "./loop-guard.js";
import {
  CompactionAttemptLedger,
} from "./compaction-attempt.js";
import {
  loadPlan,
  mutatePlan,
  isPlanTerminal,
  type SessionPlan,
  type TaskEvidence,
} from "../store/plan.js";
import type { AgentEvent } from "./events.js";
import {
  type SalvagedWrite,
  buildTurnHistory,
  looksLikePentestTask,
  looksLikeBuildTask,
  looksLikeInformationalQuery,
  looksLikeIdleOrSocialPrompt,
} from "./tool-call-parser.js";
import {
  createSessionPolicy,
  isPreApprovalAllowedTool,
  isPlanApprovedByStatus,
  planHasOpenWork,
  isAbortError,
  shouldEnableImageOcr,
  type SessionPolicy,
} from "./session-policy.js";
import {
  codingSessionFromContext,
} from "./progress-pause-policy.js";
import {
  planContextMessage,
  upsertPlanContextMessage,
} from "./plan-tool.js";
import {
  canMarkTaskDone,
  type LooseWorkReceipt,
  userAskedForFeatureApp,
  type TaskWorkLedger,
} from "./task-evidence.js";
import {
  looksLikeContinueOrResumePrompt,
  type PreviousTurnSignal,
} from "./continue-orient.js";
import { detectPackageManager } from "./workspace-orient.js";
import {
  createRecoveryBudgets,
} from "./must-continue.js";
import {
  EngagementPolicyEngine,
  engagementActionsForToolCall,
} from "../safety/engagement-policy.js";
import {
  getActiveProjectRoot,
} from "./project-root.js";
import {
  scaffoldLooksMaterialized,
} from "./workspace-orient.js";
import {
  stdioConfirmPort,
  restoreInteractiveStdin,
  confirmToolExecution,
  type ConfirmPort,
} from "./confirm-port.js";
import { composeAgentSystemPrompt, type AgentPromptSection } from "./prompt-composer.js";
import {
  createGovernorState,
} from "./evidence-governor.js";
import {
  createTurnState,
  transitionTurn,
  type TurnState,
  type TurnStateSnapshot,
} from "./turn-state.js";
import {
  inferOutcomeKind,
  openOutcomeState,
  saveOutcomeState,
  type OutcomeEnvelope,
} from "./outcomes.js";
import {
  type LoopGuardStopInfo,
  type TurnOutcomeStatus,
} from "./turn-outcome.js";


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
  const turnWriters = createTurnEventEmitter(eventPort, outputState);
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
  } = turnWriters;
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
    const loop: TurnLoopState = {
      provider: initialProvider,
      model: initialModel,
      step: -1,
      lastAnswer: "",
      pendingCalls: [],
      allowModelFallback: false,
      preferModelFallback: false,
      retryWithoutThinking: false,
      stepMaxTokens: 0,
      dispatchedRawRequestTokens: 0,
      interruptedVisible: "",
      interruptedReasoning: "",
      lowYieldResumptions: 0,
      emptyVisibleRetries: 0,
      malformedNativeArgsRounds: 0,
      truncatedBudgetRounds: 0,
      continuationBudgetFloor: 0,
      consecutiveSynthesizedRounds: 0,
      freeTierConsecutiveFailures: 0,
      freeTierLargeContextWarned: false,
      freeTierAdvisoryShown: false,
      lastSuccessfulRequestSnapshot: options.previousSuccessfulRequest,
      batchRemindCalls: new Set(),
      batchReminderNote: "",
      codingSession: false,
    };
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
    await ensureProviderConfigured(loop.provider);
    const currentContextLimitTokens = (): number | undefined =>
      options.getContextLimitTokens
        ? options.getContextLimitTokens(loop.provider, loop.model)
        : options.contextLimitTokens;
    // Some free-tier routes have a per-request/per-minute input budget below
    // the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget = providerInputTokenBudget(loop.provider, loop.model);
    const useCompactSystemPrompt = inputTokenBudget !== undefined;
    const selectToolDefs = (
      native: boolean,
      compact: boolean,
      routeProvider: ProviderId = loop.provider,
      routeModel: string = loop.model,
    ): ToolDefinition[] | undefined =>
      toolRouting.selectToolDefs(native, compact, routeProvider, routeModel);
    const buildStableSystemContent = (native: boolean): string =>
      toolRouting.buildStableSystemContent(native, loop.provider, loop.model);
    let { dialect: toolDialect, native: nativeToolsActive } = resolveNativeTools(
      loop.provider,
      loop.model,
    );
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
    const counters = createTurnCounters();
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    const toolState = createToolExecutionState(
      activePlan,
      createGovernorState(),
    );
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
    const { messages, requestContextMessage } = assembleTurnMessages({
      prompt,
      displayPrompt: options.displayPrompt,
      images: options.images,
      history: options.history,
      systemPrompt: fullSystemPrompt,
      requestContext,
    });
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


    // Robust stream-failure recovery. When a provider stream/complete fails we
    // try working approaches (backoff, compaction, thinking-off, provider
    // fallback) before surrendering the turn — see ./stream-recovery. Both are
    // reset on any successful stream so each failure episode gets a fresh
    // budget and we only give up in the worst case.
    const recoveryState = createStreamRecoveryState();

    // Track tool calls truncated by the token limit so we can ask the model
    // to retry in smaller pieces instead of leaking broken JSON as an answer.

    /** Consecutive model rounds whose native tool arguments were unusable. */



    // Track a ```tool fence that is present but whose JSON could not be parsed
    // (e.g. malformed extra/missing braces that are NOT simple truncation). We
    // retry instead of leaking the raw block as the final answer.


    const recovery = createRecoveryBudgets();
    const evidenceFlags = createTurnEvidenceFlags();
    const featureAppAsk = userAskedForFeatureApp(prompt);
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
          evidenceFlags.sawServerStart = true;
        }
        if (e.sawServerReady || e.sawDevServerStart) evidenceFlags.sawServerTail = true;
        if (e.sawLocalHttpProbeOk) evidenceFlags.sawLocalHttpProbe = true;
        if (e.sawRemoteActiveTestOk) evidenceFlags.sawActivePentestTest = true;
      }
    };
    rehydrateSessionFlagsFromPlan(activePlan);

    const taskGatePorts = {
      getLiveLedger: () => toolState.taskWorkLedger,
      setLiveLedger: (ledger: TaskWorkLedger) => {
        toolState.taskWorkLedger = ledger;
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
        featureSeen: evidenceFlags.sawFeatureImplWrite,
        scaffoldOk: evidenceFlags.sawScaffoldOk,
        serverStarted: evidenceFlags.sawServerStart,
        serverProbedOk: evidenceFlags.sawLocalHttpProbe,
        lastProbeFailed: evidenceFlags.sawFailedLocalHttpProbe,
        lastOkTool: toolState.taskWorkLedger?.lastOkTool,
        pentestSession,
      }),
    });
    refreshSessionState(activePlan);


    // Multi-task sync guard state (recomputed per model message before execution).

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


    const analysis = analyzeTask(prompt);
    const hasHistory = (options.history?.length ?? 0) > 0;
    const buildLike = buildLikeTurn;
    const pentestLike = looksLikePentestTask(prompt, options.history);
    loop.codingSession = codingSessionFromContext({
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

    /** Successful file mutation this turn — kills false "error diagnosed but not fixed". */
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
        loopGuard.recordAttempt(loop.step, call.name, call.args, ok, 0, output),
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

    const singleToolDeps: SingleToolDeps = {
      ...turnWriters,
      session,
      emit,
      options,
      messages,
      prompt,
      provider: () => loop.provider,
      model: () => loop.model,
      step: () => loop.step,
      isPlanMode,
      maxSteps,
      pentestSession,
      imageOcrEnabled,
      narrowNmapOperation,
      destinationHint,
      scratchDir: scratchDirFor(safeCwd()),
      loopGuard,
      mcpRuntime,
      workLedger,
      confirmPort,
      promptMutex,
      engagementPolicy,
      responderClaims,
      outcomeState,
      codingSession: () => loop.codingSession,
      toolState,
      alreadyPrintedIds,
      sessionLooseWork,
      deferredPostToolMessages,
      deferredResponderLedgerNotifications,
      batchRemindCalls: () => loop.batchRemindCalls,
      batchReminderNote: () => loop.batchReminderNote,
      turnState: () => turnState,
      probeStateKey,
      moveTurn,
      persistTaskEvidence,
      persistProjectRootOnPlan,
      completionGateForTask,
      matchesWakeRevision,
      executeMcpAgentCall,
      responderWakeTurn,
      responderWakeNotificationId,
      responderWakeJobId,
      responderWakeResultRevision,
    };
    const executeSingleTool = (
      call: ToolCall,
      toolEventId: string,
      parentSignal: AbortSignal,
    ): Promise<SingleToolResult> =>
      runSingleTool(singleToolDeps, call, toolEventId, parentSignal);

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
    // Surface the free-tier "failed N times / switch provider" advisory at most
    // once per turn — the recovery planner already narrates each retry, so
    // repeating this on every failure just adds noise.

    const { estimateNextRequestTokens, maybeAutoCompact } =
      createCompactionServices({
        messages,
        provider: () => loop.provider,
        model: () => loop.model,
        dialect: () => toolDialect,
        signal: options.signal,
        keepRecent: AUTO_COMPACT_KEEP_RECENT,
        sessionId: session.sessionId,
        outcome: outcomeState,
        ledger: workLedger,
        attempts: compactionAttempts,
        executionState: compactionExecutionState,
        contextLimitTokens: currentContextLimitTokens,
        selectTools: () =>
          selectToolDefs(nativeToolsActive, useCompactSystemPrompt),
        selectToolsForResolvedDialect: () => {
          const { native } = resolveNativeTools(loop.provider, loop.model);
          return selectToolDefs(native, useCompactSystemPrompt);
        },
        loadPlan: () => loadPlan(session.sessionId).catch(() => undefined),
        loadPlanStrict: () => loadPlan(session.sessionId),
        projectRoot: getActiveProjectRoot,
        detectPackageManager,
        pendingNotifications: () =>
          jobManager.getPendingNotifications(session.sessionId),
        runningJobs: () => jobManager.getRunningJobs(session.sessionId),
        recentJobs: () => jobManager.getRecentJobs(12, session.sessionId),
        requestSnapshot: () => loop.lastSuccessfulRequestSnapshot,
        clearRequestSnapshot: () => {
          loop.lastSuccessfulRequestSnapshot = undefined;
        },
        instructionsBlock: () => agentInstructionsBlock,
        skillsBlock: () => activeSkillsBlock,
        planApproved: () => session.planApproved.value,
        resetReadOnlyGuard: () => loopGuard.resetReadOnly(),
        refreshSessionState: (plan) => refreshSessionState(plan),
        setLastCompactionMsgCount: (count) => {
          lastCompactionMsgCount = count;
        },
        writeDelta: writeCompactionDelta,
        writeStarted: writeCompactionStarted,
        writeFailed: writeCompactionFailed,
        writeCompleted: writeCompactionCompleted,
        notify: writeNotice,
        audit: (event, payload) => {
          void auditLog(event, payload);
        },
      });

    const loopDeps: TurnLoopDeps = {
      ...turnWriters,
      loop,
      counters,
      toolState,
      evidenceFlags,
      recovery,
      session,
      options,
      emit,
      messages,
      prompt,
      outputState,
      maxIterations,
      isPlanMode,
      activePlan,
      buildLike,
      buildLikeTurn,
      pentestLike,
      pentestLikeTurn,
      pentestSession,
      featureAppAsk,
      informationalQuery,
      idleOrSocialPrompt,
      useCompactSystemPrompt,
      thinking: config.thinking,
      loopGuard,
      mcpRuntime,
      mcpLease,
      outcomeState,
      responderClaims,
      responderWakeTurn,
      responderWakeNotificationId,
      wireOccurrences,
      recoveryState,
      toolResultHashes,
      alreadyPrintedIds,
      deferredPostToolMessages,
      deferredResponderLedgerNotifications,
      dialect: () => toolDialect,
      setDialect: (dialect, native) => {
        toolDialect = dialect;
        nativeToolsActive = native;
      },
      nativeToolsActive: () => nativeToolsActive,
      composeCurrentSystemPrompt,
      currentContextLimitTokens,
      estimateNextRequestTokens,
      selectToolDefs,
      maybeAutoCompact,
      resolveNativeTools,
      refreshResponderInbox,
      refreshAgentInstructions,
      refreshSessionState,
      recoveryUserMessage,
      applySalvagedWrite,
      probeStateKey,
      moveTurn,
      finishTurn,
      executeSingleTool,
      nextToolEventId: () => `tool-${++nextToolEventId}`,
      pushAssistantHistory,
      liveMessages: () => liveMessages,
      upsertActionCycleRecovery,
    };

    return await runTurnRounds(loopDeps, {
      delay: (ms) => delay(ms, options.signal),
    });
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
