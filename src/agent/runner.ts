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
  onMessages?: ((messages: ChatMessage[]) => void) | undefined;
  onSuccessfulRequest?:
    ((snapshot: SuccessfulRequestSnapshot) => void) | undefined;
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
  mode?: Mode | undefined;
  displayPrompt?: string | null | undefined;
  previousTurn?: PreviousTurnSignal | undefined;
  contextLimitTokens?: number | undefined;
  getContextLimitTokens?: (
    provider: ProviderId | undefined,
    model: string | undefined,
  ) => number | undefined;
}

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
  let liveMessages: ChatMessage[] = [];
  let suppressOutcomeDiagnostics = false;
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
    if (!session.pendingTaskBatch)
      session.pendingTaskBatch = { value: undefined };
    if (!session.pendingDependency)
      session.pendingDependency = { value: undefined };
    if (!getActiveSessionWorkspace()) {
      beginSessionWorkspace();
    }

    const counters = createTurnCounters();
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    const toolState = createToolExecutionState(
      activePlan,
      createGovernorState(),
    );
    if (activePlan && isPlanApprovedByStatus(activePlan.status)) {
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
    const engagementPolicy = new EngagementPolicyEngine();
    const probeStateKey = createProbeStateKey({
      getJob: (id) => jobManager.getJob(id),
      recentJobs: () => jobManager.getRecentJobs(100, session.sessionId),
    });


    const recoveryState = createStreamRecoveryState();




    const recovery = createRecoveryBudgets();
    const evidenceFlags = createTurnEvidenceFlags();
    const featureAppAsk = userAskedForFeatureApp(prompt);
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


    const deferredPostToolMessages: ChatMessage[] = [];
    const deferredResponderLedgerNotifications: ResponderNotification[] = [];

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
    const workLedger = new WorkLedger();
    const turnStateMachine = createTurnStateMachine();
    const moveTurn = turnStateMachine.move;

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

    const AUTO_COMPACT_KEEP_RECENT = 2;
    let lastCompactionMsgCount = 0;
    const compactionAttempts = new CompactionAttemptLedger();
    const compactionExecutionState: CompactionExecutionState = {};
    const toolResultHashes = new Map<
      string,
      { toolName: string; count: number }
    >();

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

export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  return (await runAgentTurn(prompt, options)).answer;
}
