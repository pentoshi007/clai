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
import { createStreamRecoveryState } from "./stream-recovery.js";
import type {
  SingleToolResult,
  TurnEventPort,
  TurnOutputState,
} from "./turn/contracts.js";
import { createTurnFinisher } from "./turn/finalizer.js";
import { createTurnEvidenceFlags } from "./turn/evidence-flags.js";
import { createWireOccurrenceLedger } from "./turn/loop/wire-occurrences.js";
import {
  createPromptMutex,
  readSalvagedWriteReceipt,
  salvagedWriteCall,
  type SalvagedWriteReceipt,
} from "./turn/tool-call-preparation.js";
import {
  type PlanMutator,
} from "./turn/plan-persistence.js";
import { createTurnEventEmitter } from "./turn/event-emitter.js";
import {
  createProbeStateKey,
  createTurnStateMachine,
} from "./turn/setup/turn-state-machine.js";
import { ResponderClaimLedger } from "./turn/responder-claims.js";
import { buildSystemSections } from "./turn/system-sections.js";
import { createToolRouting } from "./turn/tool-routing.js";
import { runSingleTool } from "./turn/tool-execution/single-tool.js";
import { runTurnRounds } from "./turn/loop/run-rounds.js";
import type { TurnLoopDeps } from "./turn/loop/deps.js";
import type { SingleToolDeps } from "./turn/tool-execution/deps.js";
import { createToolExecutionState } from "./turn/tool-execution/state.js";
import { createTurnLoopState } from "./turn/loop/state.js";
import { classifyTurnPrompt } from "./turn/setup/prompt-classification.js";
import { setUpResponderWake } from "./turn/setup/responder-wake.js";
import { composeTurnMessages } from "./turn/setup/turn-messages.js";
import { buildMcpAgentToolPorts } from "./turn/setup/mcp-agent-ports.js";
import { openTurnBudget } from "./turn/setup/turn-budget.js";
import { buildSessionStateRefresher } from "./turn/setup/session-state.js";
import { rehydrateEvidenceFlagsFromPlan } from "./turn/setup/evidence-rehydration.js";
import { setUpTaskGate } from "./turn/setup/task-gate-setup.js";
import { createTurnCounters } from "./turn/turn-counters.js";
import { createCompactionServices } from "./turn/setup/compaction-services.js";
import { createTurnHistoryWriter } from "./turn/history-writer.js";
import { shouldYieldForDeclaredResponderDependency as declaredResponderDependencyYields } from "./turn/responder-dependency.js";
import {
  loadTurnInstructions,
  orientTurnWorkspace,
} from "./turn/workspace-setup.js";
import {
  createMcpAgentCallFailure,
  createMcpAgentToolExecutor,
} from "./turn/mcp-agent-tools.js";
import {
  createResponderInboxRefresher,
} from "./turn/responder-inbox.js";
import { type CompactionExecutionState } from "./turn/compaction-summarizer.js";
import { type ToolCallingMode } from "../llm/tool-protocol.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../ui-core/rendering/sanitize-display.js";
import {
  jobManager,
  type BackgroundJob,
  type ResponderNotification,
} from "../tools/jobs.js";
import { scratchDirFor } from "../prompts/index.js";
import { getConfig, getProviderModel } from "../store/config.js";
import {
  beginSessionWorkspace,
  getActiveSessionWorkspace,
} from "../store/session-workspace.js";
import { scopeTargetForToolCall } from "../safety/classifier.js";

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
import { WorkLedger } from "./durable-envelope.js";
import { LoopGuard } from "./loop-guard.js";
import { CompactionAttemptLedger } from "./compaction-attempt.js";
import {
  loadPlan,
  mutatePlan,
  type SessionPlan,
} from "../store/plan.js";
import type { AgentEvent } from "./events.js";
import {
  type SalvagedWrite,
  buildTurnHistory,
  looksLikePentestTask,
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
import { codingSessionFromContext } from "./progress-pause-policy.js";
import {
  type LooseWorkReceipt,
  userAskedForFeatureApp,
} from "./task-evidence.js";
import {
  type PreviousTurnSignal,
} from "./continue-orient.js";
import { detectPackageManager } from "./workspace-orient.js";
import { createRecoveryBudgets } from "./must-continue.js";
import {
  EngagementPolicyEngine,
  engagementActionsForToolCall,
} from "../safety/engagement-policy.js";
import { getActiveProjectRoot } from "./project-root.js";
import {
  stdioConfirmPort,
  type ConfirmPort,
} from "./confirm-port.js";
import { createGovernorState } from "./evidence-governor.js";

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
    ((snapshot: SuccessfulRequestSnapshot) => void) | undefined;
  /**
   * The session's last successful main request from an earlier turn. Seeds the
   * local snapshot so a first-iteration auto-compaction can still replay the
   * exact cached prefix instead of re-rendering the transcript.
   */
  previousSuccessfulRequest?: SuccessfulRequestSnapshot | undefined;
  onOutcome?:
    ((outcome: import("./turn-outcome.js").TurnOutcome) => void) | undefined;
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
    options.mode === "plan" ||
    options.mode === "agent" ||
    options.mode === "ask"
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
  const finishTurn = createTurnFinisher({
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
  });

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
      mcpRuntime?.toolDefinitions({
        ...(agentMode === "ask" ? { askMode: true } : {}),
      }) ?? [];
    mcpLease = mcpRuntime?.beginTurn();
    const mcpToolNames = mcpToolDefinitions.map(
      (definition) => definition.name,
    );
    const maxSteps = options.maxSteps ?? 70;
    const confirmPort = options.confirm ?? stdioConfirmPort;
    const projectContext = await loadProjectContext();
    const skillIndex = await getSkillIndex({
      cwd: safeCwd(),
      ...(getActiveProjectRoot()
        ? { projectRoot: getActiveProjectRoot()! }
        : {}),
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
    const loop = createTurnLoopState({
      provider: initialProvider,
      model: initialModel,
      previousSuccessfulRequest: options.previousSuccessfulRequest,
    });
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
    const classification = classifyTurnPrompt(prompt, options.history);
    const {
      buildLikeTurn,
      pentestLikeTurn,
      narrowNmapOperation,
      informationalQuery,
      idleOrSocialPrompt,
    } = classification;
    suppressOutcomeDiagnostics = classification.suppressDiagnostics;
    await ensureProviderConfigured(loop.provider);
    const currentContextLimitTokens = (): number | undefined =>
      options.getContextLimitTokens
        ? options.getContextLimitTokens(loop.provider, loop.model)
        : options.contextLimitTokens;
    // Some free-tier routes have a per-request/per-minute input budget below
    // the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget = providerInputTokenBudget(
      loop.provider,
      loop.model,
    );
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
    let { dialect: toolDialect, native: nativeToolsActive } =
      resolveNativeTools(loop.provider, loop.model);
    const session: SessionPolicy = options.session ?? createSessionPolicy();
    // Defensive init: external/legacy callers may build a policy without the
    // newer sync-guard holders. Never dereference an undefined holder.
    if (!session.pendingTaskBatch)
      session.pendingTaskBatch = { value: undefined };
    if (!session.pendingDependency)
      session.pendingDependency = { value: undefined };
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
    const pentestPromptTurn = pentestLikeTurn || activePlan?.kind === "pentest";
    const { sections: systemSections, pentestSession } =
      await buildSystemSections({
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
    const composeCurrentSystemPrompt = (native: boolean): string =>
      buildStableSystemContent(native);
    const composed = composeTurnMessages({
      prompt,
      displayPrompt: options.displayPrompt,
      images: options.images,
      history: options.history,
      mode: agentMode,
      systemSections,
      selectedSkillNames,
      nativeToolsActive,
      inputTokenBudget,
      stableSystemContent: buildStableSystemContent,
      instructionsBlock: agentInstructionsBlock,
      skillsBlock: activeSkillsBlock,
      plan: activePlan,
      planApproved: session.planApproved.value,
    });
    const messages = composed.messages;
    const requestContextMessage = composed.requestContextMessage;
    liveMessages = messages;
    const refreshInjectedBlocks = (): void => {
      upsertAgentInstructionsMessage(messages, agentInstructionsBlock);
      upsertActiveSkillsMessage(messages, activeSkillsBlock);
    };
    const responderWakeSetup = setUpResponderWake({
      prompt,
      displayPrompt: options.displayPrompt,
      pendingNotifications: jobManager.getPendingNotifications(
        session.sessionId,
      ),
    });
    const responderWake = responderWakeSetup.wake;
    const responderWakeTurn = responderWakeSetup.wakeTurn;
    const responderWakeNotificationId = responderWakeSetup.notificationId;
    const responderWakeJobId = responderWakeSetup.jobId;
    const responderWakeResultRevision = responderWakeSetup.resultRevision;
    const matchesWakeRevision = responderWakeSetup.matchesRevision;
    if (responderWakeSetup.claimedNotificationId) {
      responderClaims.add(responderWakeSetup.claimedNotificationId);
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
    const probeStateKey = createProbeStateKey({
      getJob: (id) => jobManager.getJob(id),
      recentJobs: () => jobManager.getRecentJobs(100, session.sessionId),
    });

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

    rehydrateEvidenceFlagsFromPlan(evidenceFlags, activePlan);

    const mutateSessionPlan: PlanMutator = (mutator) =>
      mutatePlan(session.sessionId, mutator);
    const taskGate = setUpTaskGate({
      toolState,
      looseWork: sessionLooseWork,
      featureAppRequired: featureAppAsk,
      projectRoot: getActiveProjectRoot,
      mutatePlan: mutateSessionPlan,
    });
    const ledgerForTaskGate = taskGate.ledgerForTask;
    const completionGateForTask = taskGate.completionGateForTask;
    const persistProjectRootOnPlan = taskGate.persistProjectRootOnPlan;
    const persistTaskEvidence = taskGate.persistTaskEvidence;

    refreshSessionState = buildSessionStateRefresher({
      messages,
      prompt,
      requestContextMessage,
      refreshInjectedBlocks,
      suppressed: idleOrSocialPrompt || informationalQuery,
      requiresState: buildLikeTurn || pentestLikeTurn,
      featureAppAsk,
      pentestSession,
      evidenceFlags,
      toolState,
      activePlan: () => activePlan,
      planApproved: () => session.planApproved.value,
      runningJobs: () => jobManager.getRunningJobs(session.sessionId),
      projectRoot: getActiveProjectRoot,
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

    const hasHistory = (options.history?.length ?? 0) > 0;
    const buildLike = buildLikeTurn;
    const pentestLike = looksLikePentestTask(prompt, options.history);
    loop.codingSession = codingSessionFromContext({
      buildLike,
      planKind: activePlan?.kind,
    });
    const budget = await openTurnBudget({
      prompt,
      sessionId: session.sessionId,
      plan: activePlan,
      history: options.history,
      maxSteps,
      buildLike,
      pentestLike,
      restoreCompletedOperations: (operations) =>
        loopGuard.restoreCompletedOperations(operations ?? []),
    });
    const outcomeState = budget.outcomeState;
    const analysis = budget.analysis;
    const maxIterations = budget.maxIterations;
    // Canonical mutation/artifact ledger feeding the durable compaction envelope.
    const workLedger = new WorkLedger();
    const turnStateMachine = createTurnStateMachine();
    const moveTurn = turnStateMachine.move;

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
    const mcpAgentToolPorts = buildMcpAgentToolPorts({
      askMode: agentMode === "ask",
      autoConfirm: Boolean(options.autoConfirm),
      session,
      confirmPort,
      promptMutex,
      loopGuard,
      step: () => loop.step,
      isPrinted: (eventId) => alreadyPrintedIds.has(eventId),
      markPrinted: (eventId) => alreadyPrintedIds.add(eventId),
      writeToolCall,
      writeToolOutput,
      emitToolResult,
    });
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
      turnState: () => turnStateMachine.snapshot(),
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
      ...singleToolDeps,
      options,
      ...turnWriters,
      loop,
      counters,
      evidenceFlags,
      recovery,
      outputState,
      maxIterations,
      activePlan,
      buildLike,
      buildLikeTurn,
      pentestLike,
      pentestLikeTurn,
      featureAppAsk,
      informationalQuery,
      idleOrSocialPrompt,
      useCompactSystemPrompt,
      thinking: config.thinking,
      mcpLease,
      wireOccurrences,
      recoveryState,
      toolResultHashes,
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
