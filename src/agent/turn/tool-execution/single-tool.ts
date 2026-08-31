import type { PolicyLease } from "../../../safety/engagement-policy.js";
import type { EngagementActionRecord, EngagementGraph } from "../../../store/engagement.js";
import type { ToolCall, ToolResult } from "../../../types.js";
import type { SingleToolResult } from "../contracts.js";
import { isCanonicalToolName } from "../../../mcp/names.js";
import { safeCwd } from "../../../os/cwd.js";
import { scratchDirFor } from "../../../prompts/index.js";
import { classifyToolCall, isPentestToolCall } from "../../../safety/classifier.js";
import { auditLog } from "../../../store/logs.js";
import { loadPlan, mutatePlan } from "../../../store/plan.js";
import { isScopeActive, loadScopeForSession } from "../../../store/scope.js";
import { MCP_AGENT_TOOL_NAMES } from "../../../tools/definitions.js";
import { jobManager } from "../../../tools/jobs.js";
import { normalizeToolCall, runToolCall } from "../../../tools/registry.js";
import { stdioSecretRequester } from "../../confirm-port.js";
import { saveOutcomeState } from "../../outcomes.js";
import { handlePlanTool, removePlanContextMessage } from "../../plan-tool.js";
import { extractProjectRootFromPlan, getActiveProjectRoot, setActiveProjectRootIfValid } from "../../project-root.js";
import { outOfScopeToolMessage } from "../../scope-context.js";
import { isAbortError } from "../../session-policy.js";
import { TOOL_ABORT_GRACE_MS, applyDestinationCwd, isEvidenceWorkTool, toolHardBudgetMs, toolStallBudgetMs } from "../../task-evidence.js";
import { formatToolContext, saveToolOutput } from "../../tool-output-formatting.js";
import { accountToolOutcome } from "../../turn/outcome-accounting.js";
import { linkResponderJobToPlan } from "../../turn/responder-job-linkage.js";
import { reconcileScaffoldOutcome } from "../../turn/scaffold-outcome.js";
import { decideScaffoldPreflight } from "../../turn/scaffold-preflight.js";
import { autostartPlanTask } from "../../turn/task-autostart.js";
import { invalidToolCall } from "../../turn/tool-call-preparation.js";
import { authorizeToolExecution } from "../../turn/tool-execution/authorization.js";
import { resolveToolDispatch } from "../../turn/tool-execution/dispatch.js";
import { recordEngagementOutcome } from "../../turn/tool-execution/engagement-checkpoint.js";
import { evaluateEngagementGate } from "../../turn/tool-execution/engagement-gate.js";
import { runToolGates } from "../../turn/tool-execution/gates.js";
import { LOOP_RESET_OUTPUT, evaluateLoopGuardBlock, evaluateToolGuards, readRetryReason } from "../../turn/tool-execution/guards.js";
import { runMetaTool } from "../../turn/tool-execution/meta-tools.js";
import { creditToolWork, frameToolResult, reportToolFailure } from "../../turn/tool-execution/result-framing.js";
import { buildEngagementRunOptions, createEphemeralToolJob } from "../../turn/tool-execution/run-setup.js";
import { superviseToolExecution } from "../../turn/tool-execution/supervision.js";
import { createToolWatchdog } from "../../turn/tool-watchdog.js";
import { scopeTargetForToolCall } from "../../../safety/classifier.js";
import { engagementActionsForToolCall } from "../../../safety/engagement-policy.js";
import type { SingleToolDeps } from "./deps.js";

const safeScopeTargetForToolCall = (call: ToolCall): string | undefined => {
  try {
    return scopeTargetForToolCall(call);
  } catch {
    return undefined;
  }
};

const safeEngagementActionsForToolCall = (
  call: ToolCall,
): ReturnType<typeof engagementActionsForToolCall> => {
  try {
    return engagementActionsForToolCall(call);
  } catch {
    return [];
  }
};

export const runSingleTool = async (
  deps: SingleToolDeps,
  rawCall: ToolCall,
  toolEventId: string,
  parentSignal: AbortSignal,
): Promise<SingleToolResult> => {

  const scratchDir = scratchDirFor(safeCwd());
  const normalizedCall = normalizeToolCall(rawCall);
  const canonicalMcpName = deps.mcpRuntime?.canonicalizeToolName(normalizedCall.name);
  let call =
    canonicalMcpName && canonicalMcpName !== normalizedCall.name
      ? { ...normalizedCall, name: canonicalMcpName }
      : normalizedCall;

  const emitVisibleSyntheticReceipt = (
    result: ToolResult,
    summary: string,
  ): void => {
    if (!deps.alreadyPrintedIds.has(toolEventId)) {
      deps.writeToolCall(toolEventId, call);
      deps.alreadyPrintedIds.add(toolEventId);
    }
    deps.emit({ type: "tool-start", id: toolEventId });
    const output = result.output.endsWith("\n")
      ? result.output
      : `${result.output}\n`;
    deps.writeToolOutput(toolEventId, output);
    deps.emitToolResult(toolEventId, result, summary);
  };

  let engagementLease: PolicyLease | undefined;
  let engagementGraph: EngagementGraph | undefined;
  let engagementRecord: EngagementActionRecord | undefined;

  const invalid = invalidToolCall(call);
  if (invalid) {
    deps.emitToolResult(toolEventId, invalid.result, invalid.reason);
    return {
      ok: false,
      call,
      result: invalid.result,
      contextOutput: invalid.reason,
    };
  }

  if (call.name === "image.ocr" && !deps.imageOcrEnabled) {
    deps.writeNotice(
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
    narrowNmapOperation: deps.narrowNmapOperation,
    narrowNmapDispatched: deps.toolState.narrowNmapDispatchCount,
    heldBatchReminder:
      call.name === "task.update" && deps.batchRemindCalls().has(rawCall)
        ? deps.batchReminderNote()
        : undefined,
  });
  if (guard.kind === "reject") {
    const result = { ok: false, output: guard.reason, exitCode: 1 };
    deps.emitToolResult(toolEventId, result, guard.reason);
    return { ok: false, call, result, contextOutput: guard.reason };
  }
  if (guard.kind === "hold") {
    if (!deps.alreadyPrintedIds.has(toolEventId)) {
      deps.writeToolCall(toolEventId, call);
      deps.alreadyPrintedIds.add(toolEventId);
    }
    const result = { ok: false, output: guard.reason, exitCode: 1 };
    deps.emitToolResult(toolEventId, result, guard.reason);
    deps.writeToolOutput(toolEventId, "held\n");
    return { ok: false, call, result, contextOutput: guard.reason };
  }
  if (guard.kind === "proceed" && guard.consumesNarrowNmapScan) {
    deps.toolState.narrowNmapDispatchCount += 1;
  }

  const retryReason = readRetryReason(call.args);
  const currentProbeState = deps.probeStateKey(call);
  const loopCheck = deps.loopGuard.shouldBlock(call.name, call.args, {
    dependenciesChanged: deps.toolState.retryDependenciesChanged,
    environmentChanged: deps.toolState.retryEnvironmentChanged,
    ...(currentProbeState ? { stateKey: currentProbeState } : {}),
    ...(retryReason ? { retryReason } : {}),
  });
  const loopDecision = evaluateLoopGuardBlock(call, {
    verdict: loopCheck,
    priorObservation:
      loopCheck.kind === "unchanged-success"
        ? deps.loopGuard.getPriorObservation(call.name, call.args)
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
    deps.writeNotice("warn", loopDecision.reason);
    const result = { ok: false, output: loopDecision.reason, exitCode: 1 };
    deps.emitToolResult(toolEventId, result, loopDecision.reason);
    return { ok: false, call, result, contextOutput: loopDecision.reason };
  }

  if (call.name === "loop.reset") {
    deps.loopGuard.resetAllSequenceCounts();
    const output = LOOP_RESET_OUTPUT;
    const result: ToolResult = { ok: true, output, exitCode: 0 };
    emitVisibleSyntheticReceipt(result, output);
    deps.loopGuard.recordAttempt(deps.step(), call.name, call.args, true, 0, output);
    return { ok: true, call, result, contextOutput: output };
  }

  if (deps.mcpRuntime && MCP_AGENT_TOOL_NAMES.has(call.name)) {
    return deps.executeMcpAgentCall(deps.mcpRuntime, call, toolEventId);
  }

  const metaOutcome = await runMetaTool(
    {
      step: deps.step(),
      wake: {
        wakeTurn: deps.responderWakeTurn,
        notificationId: deps.responderWakeNotificationId,
        jobId: deps.responderWakeJobId,
        resultRevision: deps.responderWakeResultRevision,
      },
      pendingNotifications: () =>
        jobManager.getPendingNotifications(deps.session.sessionId),
      matchesWakeRevision: deps.matchesWakeRevision,
      isClaimed: (id) => deps.responderClaims.has(id),
      markRead: (id) => jobManager.markRead(id, deps.session.sessionId),
      releaseClaim: (id) => deps.responderClaims.delete(id),
      queueResponderLedger: (notification) =>
        deps.deferredResponderLedgerNotifications.push(notification),
      loadPlan: () => loadPlan(deps.session.sessionId).catch(() => undefined),
      completionGate: (livePlan, taskId) =>
        deps.completionGateForTask(livePlan, taskId),
      handlePlanTool: (planCall) =>
        handlePlanTool(planCall, deps.session, {
          loopGuard: deps.loopGuard,
          step: deps.step(),
          autoApprove: !deps.isPlanMode,
        }),
      recordAttempt: (attemptedCall, ok) =>
        deps.loopGuard.recordAttempt(
          deps.step(),
          attemptedCall.name,
          attemptedCall.args,
          ok,
          0,
        ),
      showCall: (shownCall) => {
        if (deps.alreadyPrintedIds.has(toolEventId)) return;
        deps.writeToolCall(toolEventId, shownCall);
        deps.alreadyPrintedIds.add(toolEventId);
      },
      notify: deps.writeNotice,
      emitToolResult: (result, contextOutput) =>
        deps.emitToolResult(toolEventId, result, contextOutput),
      writeToolOutput: (chunk) => deps.writeToolOutput(toolEventId, chunk),
      renderPlan: deps.writePlanUpdate,
      adoptProjectRoot: (plan) => {
        const root = extractProjectRootFromPlan(plan);
        if (root) setActiveProjectRootIfValid(root);
      },
      setPendingSessionStatePlan: (plan) => {
        deps.toolState.pendingSessionStatePlan = plan;
      },
      clearPlanContext: () => {
        removePlanContextMessage(deps.messages);
        deps.emit({ type: "plan-cleared", sessionId: deps.session.sessionId });
      },
      getLedger: () => deps.toolState.taskWorkLedger,
      setLedger: (ledger) => {
        deps.toolState.taskWorkLedger = ledger;
      },
      looseWork: () => deps.sessionLooseWork,
      persistTaskEvidence: deps.persistTaskEvidence,
    },
    call,
  );
  if (metaOutcome.kind === "handled") return metaOutcome.result;

  const scope = await loadScopeForSession(deps.session.sessionId);
  const decision =
    deps.mcpRuntime?.classify(call.name) ?? classifyToolCall(call, { scope });
  await auditLog("tool.classified", {
    call,
    decision,
    scope: isScopeActive(scope) ? (scope.name ?? "(unnamed)") : "(none)",
  });

  const livePlanForPreGate = await loadPlan(deps.session.sessionId).catch(
    () => undefined,
  );

  const gateDecision = await runToolGates(
    {
      isPlanMode: deps.isPlanMode,
      planApproved: () => deps.session.planApproved.value,
      scratchDir,
      mcpSafe: (gatedCall) =>
        deps.mcpRuntime?.classify(gatedCall.name)?.level === "safe",
      loadPlan: () => loadPlan(deps.session.sessionId).catch(() => undefined),
      notify: deps.writeNotice,
      showCall: (shownCall) => {
        if (deps.alreadyPrintedIds.has(toolEventId)) return;
        deps.writeToolCall(toolEventId, shownCall);
        deps.alreadyPrintedIds.add(toolEventId);
      },
      emitToolResult: (result, contextOutput) =>
        deps.emitToolResult(toolEventId, result, contextOutput),
      writeToolOutput: (chunk) => deps.writeToolOutput(toolEventId, chunk),
    },
    call,
    decision.level,
    livePlanForPreGate,
  );
  if (gateDecision.kind === "stop") return gateDecision.result;

  if (deps.session.planApproved.value) {
    const livePlanForGate = await loadPlan(deps.session.sessionId).catch(
      () => undefined,
    );
    if (livePlanForGate) {
      await autostartPlanTask(livePlanForGate, call, {
        openTask: async (taskId) => {
          await mutatePlan(deps.session.sessionId, (draft) => {
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
        renderPlan: deps.writePlanUpdate,
        notify: (message) => deps.writeNotice("info", message),
        getLedger: () => deps.toolState.taskWorkLedger,
        setLedger: (ledger) => {
          deps.toolState.taskWorkLedger = ledger;
        },
      });
    }
  }

  call = applyDestinationCwd(
    call,
    deps.destinationHint ?? getActiveProjectRoot(),
  );

  const scaffoldPreflight = decideScaffoldPreflight(call);
  if (scaffoldPreflight.skip) {
    if (
      scaffoldPreflight.adoptTarget &&
      scaffoldPreflight.target &&
      setActiveProjectRootIfValid(scaffoldPreflight.target, { force: true })
    ) {
      await deps.persistProjectRootOnPlan(scaffoldPreflight.target);
    }
    const message = scaffoldPreflight.message;
    deps.writeNotice("info", message);
    if (!deps.alreadyPrintedIds.has(toolEventId)) {
      deps.writeToolCall(toolEventId, call);
      deps.alreadyPrintedIds.add(toolEventId);
    }
    const result = { ok: true, output: message, exitCode: 0 };
    deps.emitToolResult(toolEventId, result, message);
    deps.writeToolOutput(toolEventId, "ok\n");
    return {
      ok: true,
      call,
      result,
      contextOutput: message,
    };
  }

  const scopeTarget = safeScopeTargetForToolCall(call);
  const engagementActions =
    deps.pentestSession || isPentestToolCall(call) || Boolean(scope)
      ? safeEngagementActionsForToolCall(call)
      : [];
  const engagementAction = engagementActions[0];
  const engagementGate = await evaluateEngagementGate(
    {
      scope,
      audit: (event, payload) => auditLog(event, payload),
    },
    call,
    engagementActions,
    scopeTarget,
  );
  const engagementDecision = engagementGate.decision;
  engagementGraph = engagementGate.graph;
  engagementRecord = engagementGate.record;
  if (engagementGate.blockedReason) {
    const reason = engagementGate.blockedReason;
    deps.writeToolBlocked(toolEventId, call.name, reason);
    const result = { ok: false, output: reason, exitCode: 1 };
    deps.emitToolResult(toolEventId, result, reason);
    return { ok: false, call, result, contextOutput: reason };
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
      autoConfirm: Boolean(deps.options.autoConfirm),
      session: deps.session,
      confirmPort: deps.confirmPort,
      acquirePrompt: () => deps.promptMutex.acquire(),
      writeToolBlocked: deps.writeToolBlocked,
      emitToolResult: deps.emitToolResult,
    },
  );
  if (authorization.kind === "stop") return authorization.result;

  parentSignal.throwIfAborted();
  const planAtDispatch = await loadPlan(deps.session.sessionId).catch(
    () => undefined,
  );
  const dispatch = await resolveToolDispatch(
    {
      mutatePlan: (mutator) => mutatePlan(deps.session.sessionId, mutator),
      renderPlan: deps.writePlanUpdate,
      setPendingSessionStatePlan: (plan) => {
        deps.toolState.pendingSessionStatePlan = plan;
      },
      notify: deps.writeNotice,
      getLedger: () => deps.toolState.taskWorkLedger,
      setLedger: (ledger) => {
        deps.toolState.taskWorkLedger = ledger;
      },
    },
    call,
    planAtDispatch,
  );
  if (dispatch.kind === "reject") {
    const result = { ok: false, output: dispatch.reason, exitCode: 1 };
    deps.emitToolResult(toolEventId, result, dispatch.reason);
    return { ok: false, call, result, contextOutput: dispatch.reason };
  }
  deps.toolState.dispatchedTaskId = dispatch.dispatchedTaskId;
  deps.toolState.delegation = dispatch.delegation;

  if (engagementAction) {
    engagementLease = deps.engagementPolicy.acquire(scope, engagementAction);
    if (!engagementLease.decision.allowed) {
      const target = engagementLease.decision.normalizedTarget || engagementAction.target;
      const reason = outOfScopeToolMessage({
        target,
        reason: engagementLease.decision.reason,
        allowed: scope?.authorizedTargets,
      });
      const result = { ok: false, output: reason, exitCode: 1 };
      deps.emitToolResult(toolEventId, result, reason);
      return { ok: false, call, result, contextOutput: reason };
    }
  }
  if (deps.turnState().state === "understanding" || deps.turnState().state === "exploring") {
    deps.moveTurn("acting", `executing ${call.name}`);
  }
  deps.options.onToolStart?.(call);
  deps.emit({ type: "tool-start", id: toolEventId });
  deps.writeStatus(call.name);


  const toolAc = new AbortController();
  const onParentAbort = () => toolAc.abort();
  parentSignal.addEventListener("abort", onParentAbort);

  let result: ToolResult;
  let liveBytes = 0;
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
    deps.writeToolOutput(toolEventId, chunk);
  };

  const { id: jobId, job: backgroundJob } = createEphemeralToolJob(
    call,
    safeCwd(),
    deps.session.sessionId,
  );
  jobManager.registerJob(jobId, backgroundJob, toolAc);


  const watchdog = createToolWatchdog({
    toolName: call.name,
    stallBudgetMs: toolStallBudgetMs(call),
    hardBudgetMs: toolHardBudgetMs(call),
    graceMs: TOOL_ABORT_GRACE_MS,
    controller: toolAc,
    notify: (message) => deps.writeNotice("warn", message),
  });
  watchdog.resetStallTimer();

  const engagementRunOptions = buildEngagementRunOptions({
    action: engagementAction,
    scope,
    normalizedTarget: engagementDecision?.normalizedTarget,
    graph: engagementGraph,
    record: engagementRecord,
    audit: (event, payload) => auditLog(event, payload),
  });

  const startToolWork = (): Promise<ToolResult> =>
      deps.mcpRuntime !== undefined &&
      (deps.mcpRuntime.getTool(call.name) !== undefined ||
        isCanonicalToolName(call.name))
        ? deps.mcpRuntime.callTool(call.name, call.args, { signal: toolAc.signal })
        : runToolCall(call, {
      signal: toolAc.signal,
      requestSecret: deps.options.requestSecret ?? stdioSecretRequester,
      onOutput: (chunk) => {
        if (toolAc.signal.aborted) return;
        watchdog.resetStallTimer();
        printLive(chunk);
      },
      confirmed: true,
      userPrompt: deps.prompt,
      llmProvider: deps.provider(),
      llmModel: deps.model(),
      sessionId: deps.session.sessionId,
      ...(deps.toolState.delegation?.taskId ? { taskId: deps.toolState.delegation.taskId } : {}),
      ...(deps.toolState.delegation ? { delegationId: deps.toolState.delegation.id } : {}),
      ...(deps.toolState.dispatchedTaskId ? { parentTaskId: deps.toolState.dispatchedTaskId } : {}),
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
      writeToolOutput: (chunk) => deps.writeToolOutput(toolEventId, chunk),
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
    deps.emitToolResult(toolEventId, result, result.output);
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
    deps.writeToolOutput(toolEventId, output, { replace: true });
    deps.emitToolResult(toolEventId, result, contextOutput);
    deps.options.onToolResult?.(call, result);
    const suppressedProbeState = deps.probeStateKey(call);
    deps.loopGuard.recordAttempt(
      deps.step(),
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
    await deps.persistProjectRootOnPlan(scaffoldOutcome.adoptRoot);
  }
  if (scaffoldOutcome.notice) {
    deps.writeNotice("info", scaffoldOutcome.notice);
  }

  if (deps.toolState.delegation?.taskId && !result.backgroundJob) {
    const delegationId = deps.toolState.delegation.id;
    const settledState = result.ok ? "skipped" : "failed";
    const settlement = await mutatePlan(deps.session.sessionId, (draft) => {
      const child = draft.tasks.find(
        (task) => task.delegationId === delegationId,
      );
      if (!child) return false;
      child.state = settledState;
      child.note = result.ok
        ? `toolState.delegation=${delegationId} ran in the foreground; no durable job was created`
        : `toolState.delegation=${delegationId} failed to launch`;
      return true;
    }).catch(() => undefined);
    if (settlement?.ok && settlement.plan) {
      deps.toolState.pendingSessionStatePlan = settlement.plan;
      deps.writePlanUpdate(settlement.plan);
    }
    deps.toolState.delegation = undefined;
  }

  if (result.backgroundJob) {
    const durableJob = jobManager.getJob(result.backgroundJob.id);
    if (durableJob?.responder) {
      result = await linkResponderJobToPlan(
        {
          loadPlan: () =>
            loadPlan(deps.session.sessionId).catch(() => undefined),
          mutatePlan: (mutator) => mutatePlan(deps.session.sessionId, mutator),
          linkJob: (jobIdToLink, patch) =>
            jobManager.linkJob(jobIdToLink, patch),
          renderPlan: deps.writePlanUpdate,
          setPendingSessionStatePlan: (plan) => {
            deps.toolState.pendingSessionStatePlan = plan;
          },
          notify: deps.writeNotice,
        },
        {
          job: durableJob,
          call,
          toolEventId,
          delegationTaskId: deps.toolState.delegation?.taskId,
          dispatchedTaskId: deps.toolState.dispatchedTaskId,
        },
        result,
      );
    }
  }

  const framed = await frameToolResult(
    {
      step: deps.step(),
      saveArtifact: (savedCall, savedOutput) =>
        saveToolOutput(savedCall, savedOutput),
      setJobArtifact: (artifactPath) => {
        const storedJob = jobManager.getJob(jobId);
        if (storedJob) storedJob.artifactPath = artifactPath;
      },
      formatContext: formatToolContext,
      emitToolResult: (framedResult, contextText, artifactPath) =>
        deps.emitToolResult(
          toolEventId,
          framedResult,
          contextText,
          artifactPath,
        ),
      onToolResult: deps.options.onToolResult,
      audit: (event, payload) => auditLog(event, payload),
      recordEngagementOutcome: async (artifactPath) => {
        if (!engagementGraph || !engagementRecord) return;
        await recordEngagementOutcome(engagementGraph, engagementRecord, {
          call,
          result,
          artifactPath,
        });
      },
      recordLedgerCall: (ledgerCall, ok, artifactPath) =>
        deps.workLedger.recordToolCall(ledgerCall, ok, artifactPath),
    },
    call,
    result,
  );
  const output = result.output.trim();
  const savedOutputPath = framed.artifactPath;
  const contextOutput = framed.contextOutput;

  const completedProbeState = deps.probeStateKey(call);
  const accountingState = {
    retryDependenciesChanged: deps.toolState.retryDependenciesChanged,
    retryEnvironmentChanged: deps.toolState.retryEnvironmentChanged,
    governorState: deps.toolState.governorState,
  };
  accountToolOutcome(
    {
      outcomeState: deps.outcomeState,
      maxSteps: deps.maxSteps,
      codingSession: deps.codingSession(),
      attemptCount: (attemptedCall) =>
        deps.loopGuard.getAttemptCount(attemptedCall.name, attemptedCall.args),
      moveTurn: deps.moveTurn,
      deferMessage: (message) => deps.deferredPostToolMessages.push(message),
    },
    accountingState,
    {
      call,
      result,
      toolEventId,
      artifactPath: savedOutputPath,
      dispatchedTaskId: deps.toolState.dispatchedTaskId,
      probeStateKey: completedProbeState,
    },
  );
  deps.toolState.retryDependenciesChanged = accountingState.retryDependenciesChanged;
  deps.toolState.retryEnvironmentChanged = accountingState.retryEnvironmentChanged;
  deps.toolState.governorState = accountingState.governorState;
  await saveOutcomeState(deps.outcomeState);

  deps.loopGuard.recordAttempt(
    deps.step(),
    call.name,
    call.args,
    result.ok,
    result.exitCode,
    result.output,
    completedProbeState ? { stateKey: completedProbeState } : undefined,
  );

  const creditedPlan = await creditToolWork(
    {
      getLedger: () => deps.toolState.taskWorkLedger,
      setLedger: (ledger) => {
        deps.toolState.taskWorkLedger = ledger;
      },
      bankLooseWork: (receipt) => deps.sessionLooseWork.push(receipt),
      persistTaskEvidence: deps.persistTaskEvidence,
      loadPlan: () => loadPlan(deps.session.sessionId).catch(() => undefined),
      creditId: () => deps.toolState.dispatchedTaskId,
    },
    call,
    result,
  );
  if (result.ok && isEvidenceWorkTool(call.name)) {
    deps.toolState.pendingSessionStatePlan =
      creditedPlan ?? deps.toolState.pendingSessionStatePlan;
  }

  reportToolFailure(
    {
      reflection: () => deps.loopGuard.getFailureReflection(),
      failureCount: () => deps.loopGuard.consecutiveFailureCount(),
      deferMessage: (message) => deps.deferredPostToolMessages.push(message),
      notify: deps.writeNotice,
    },
    result.ok,
  );

  if (output) {
    const fullChunk = output.endsWith("\n") ? output : `${output}\n`;
    deps.writeToolOutput(toolEventId, fullChunk, { replace: true });
  }

  return { ok: result.ok, call, result, contextOutput };
};
