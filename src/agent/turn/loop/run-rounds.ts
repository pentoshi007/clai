import { routeCompletionBudget } from "./output-budget.js";
import { BATCH_SAFE_TOOLS } from "../../../tools/registry.js";
import type { BoundCall } from "../contracts.js";
import type { EmptyResponseState } from "./empty-response.js";
import { MAX_STEP_COMPLETION_TOKENS } from "../../reliability-policy.js";
import type { OutputBudgetState } from "./output-budget.js";
import type { RecordedToolResult } from "./round-recorder.js";
import type { ReplayedOccurrence } from "./wire-occurrences.js";
import type { ToolResult } from "../../../types.js";
import { appendAssistantWithTools } from "../../tool-history.js";
import { bindToolCalls } from "./call-binding.js";
import { buildRichStopSummary } from "../../stop-summary.js";
import { buildTurnHistory } from "../../tool-call-parser.js";
import { classifyToolCall } from "../../../safety/classifier.js";
import { closeOutRound } from "./round-closeout.js";
import { codingSessionFromContext } from "../../progress-pause-policy.js";
import { countToolFences } from "../../tool-call-parser.js";
import { createRoundRecorder } from "./round-recorder.js";
import { createRoundState } from "./round-state.js";
import { createToolResultRecorder } from "../tool-result-recorder.js";
import { decidePlanCallDeferral } from "./plan-call-deferral.js";
import { evaluateTaskBatchGuard } from "../task-batch-guard.js";
import { executeToolGroups } from "./group-execution.js";
import { formatToolArgs } from "../../tool-call-parser.js";
import { getActiveProjectRoot } from "../../project-root.js";
import { groupToolCallsForExecution } from "../../tool-call-parser.js";
import { handleEmptyResponse } from "./empty-response.js";
import { handleOutputBudgetExhaustion } from "./output-budget.js";
import { loadPlan } from "../../../store/plan.js";
import { loadScopeForSession } from "../../../store/scope.js";
import { looksLikeTruncatedToolCall } from "../../tool-call-parser.js";
import { outputBudgetExhausted } from "./output-budget.js";
import { recognizeBareToolJson } from "../../tool-call-parser.js";
import { reconcileToolCallIds } from "./call-binding.js";
import { saveOutcomeState } from "../../outcomes.js";
import { settleUnrunCalls } from "./unrun-calls.js";
import { suppressRepeatedActionSequence } from "./sequence-suppression.js";
import type { NativeToolCall, ToolCall } from "../../../types.js";
import { isTextOnlyModel, markTextOnlyModel } from "../../../llm/tool-protocol.js";
import { getConfig } from "../../../store/config.js";
import { auditLog } from "../../../store/logs.js";
import { jobManager } from "../../../tools/jobs.js";
import { rememberThinking } from "../../../ui/thinking.js";
import { collapseRepeatedText, looksLikePromptLeak, parseToolCall, textBeforeToolCall } from "../../tool-call-parser.js";
import { accountCompletionUsage, interpretCompletion } from "./completion-interpretation.js";
import { firstNativeToolCall, syncNativeToolCallCards } from "./native-tool-calls.js";
import { hasTruncatedNativeWrite, salvageTruncatedNativeWrite } from "./native-write-salvage.js";
import { requestRound } from "./round-request.js";
import { createStreamSession } from "./stream-session.js";
import type { TurnOutcome } from "../../turn-outcome.js";
import type { TurnLoopDeps } from "./deps.js";
import { resolveAnswerPath } from "./answer-path.js";

export const runTurnRounds = async (
  deps: TurnLoopDeps,
  input: { readonly delay: (ms: number) => Promise<void> },
): Promise<TurnOutcome> => {
  for (let iteration = 0; iteration < deps.maxIterations; iteration += 1) {

    deps.outputState.visibleCommitted = false;
    deps.loop.step = deps.counters.productiveSteps;
    deps.options.signal?.throwIfAborted();


    let call: ToolCall | undefined;
    let assistantText: {
      visible: string;
      thinkContent: string;
      hasThinking: boolean;
    };
    let canonicalAssistantVisible = "";
    let recoveredFromBareJson = false;

    if (deps.loop.pendingCalls.length > 0) {

      call = deps.loop.pendingCalls.shift()!;
      assistantText = { visible: "", thinkContent: "", hasThinking: false };
      const batchStatus = `  ↳ continuing batch (${deps.loop.pendingCalls.length} more queued)\n`;
      deps.writeStatus(batchStatus);
    } else {

      await deps.maybeAutoCompact("auto-token-budget");
      const responderDelivery = deps.refreshResponderInbox();

      const streamLabel =
        deps.loop.step === 0 ? "waiting for model" : `step ${deps.loop.step + 1}`;
      deps.emit({ type: "status", text: streamLabel });
      let toolsAttached = false;
      const streamSession = createStreamSession({
        emitStatus: (text) => deps.emit({ type: "status", text }),
        emitAssistantDelta: (text) => deps.emit({ type: "assistant-delta", text }),
        emitThinkingDelta: (text) => deps.emit({ type: "thinking-delta", text }),
        writeStatus: deps.writeStatus,
        notify: deps.writeNotice,
        writeToolCall: deps.writeToolCall,
        nextToolEventId: () => deps.nextToolEventId(),
        markPrinted: (eventId) => deps.alreadyPrintedIds.add(eventId),
        nativeToolsAttached: () => toolsAttached,
        onSuccessfulRequest: (snapshot) => {
          deps.loop.lastSuccessfulRequestSnapshot = snapshot;
          deps.options.onSuccessfulRequest?.(snapshot);
        },
      });
      const deferredToolCalls = streamSession.deferredToolCalls;
      const streamedNativeCallNames = streamSession.streamedNativeCallNames;
      const callIds = streamSession.callIds;
      const requested = await requestRound(deps, {
        streamSession,
        responderDelivery,
        delay: input.delay,
        setToolsAttached: (attached) => {
          toolsAttached = attached;
        },
      });
      if (requested.kind === "continue") continue;
      const completion = requested.completion;
      toolsAttached = requested.toolsAttached;
      if (responderDelivery) {
        if (!jobManager.markDelivered(responderDelivery.id, deps.session.sessionId)) {
          jobManager.releaseResponderNotificationClaim(responderDelivery.id);
        }
      }
      deps.loop.provider = completion.provider;
      deps.loop.model = completion.model;
      await accountCompletionUsage(
        {
          dispatchedRawRequestTokens: deps.loop.dispatchedRawRequestTokens,
          emitTokenUsage: ({ usage, provider: usageProvider, model: usageModel, attempt }) =>
            deps.emit({
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
      const restickied = deps.resolveNativeTools(
        deps.loop.provider,
        deps.loop.model,
      );
      deps.setDialect(restickied.dialect, restickied.native);
      const usedNativeProtocol = Boolean(completion.toolCalls?.length) ||
        (toolsAttached && !isTextOnlyModel(deps.loop.provider, deps.loop.model));

      const interpreted = interpretCompletion({
        completion,
        streamedReasoningText: streamSession.streamedReasoningText(),
        interruptedVisible: deps.loop.interruptedVisible,
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
            deps.writeAssistantMessage(displayText);
          } else {
            deps.emit({ type: "assistant-message", text: "" });
          }
          if (assistantText.hasThinking) {
            deps.emit({
              type: "thinking-block",
              content: assistantText.thinkContent,
            });
          }
        }
        deps.pushAssistantHistory(historyText, retryReasoning);
        deps.loop.interruptedVisible = "";
        deps.loop.interruptedReasoning = "";
        deps.loop.lowYieldResumptions = 0;
      };


      let nativeToolCalls: NativeToolCall[] = completion.toolCalls ?? [];
      syncNativeToolCallCards(
        {
          deferredToolCalls,
          callIds,
          allocateEventId: () => deps.nextToolEventId(),
          markPrinted: (eventId) => deps.alreadyPrintedIds.add(eventId),
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
            deps.writeNotice("info", "recovered tool call from thinking content");
          }
        }
      }

      if (looksLikePromptLeak(assistantText.visible)) {
        if (call || nativeToolCalls.length) {
          deps.writeNotice(
            "warn",
            "suppressed tool call from apparent prompt leak",
          );
        }
        call = undefined;
        nativeToolCalls = [];
        deferredToolCalls.length = 0;
      }


      if (nativeToolCalls.length) {
        deps.counters.truncatedToolRetries += hasTruncatedNativeWrite(nativeToolCalls) ? 1 : 0;
        if (deps.counters.truncatedToolRetries <= 5) {
          const salvagedNative = await salvageTruncatedNativeWrite(
            {
              messages: deps.messages,
              toolsAttached,
              notify: deps.writeNotice,
              applySalvagedWrite: deps.applySalvagedWrite,
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
          deps.loop.malformedNativeArgsRounds += 1;
          if (deps.loop.malformedNativeArgsRounds >= 2) {
            const names = [...new Set(unparseable.map((tc) => tc.name))].join(", ");
            for (const entry of deferredToolCalls) {
              if (!entry.shown || entry.call.name === "…") continue;
              deps.writeToolBlocked(
                entry.eventId,
                entry.call.name,
                "Native tool arguments were unusable again; nothing ran. Reissue as a fenced tool block.",
              );
            }
            markTextOnlyModel(deps.loop.provider, deps.loop.model);
            deps.writeNotice(
              "warn",
              "native tool arguments keep arriving unusable — switching this model to the text tool protocol",
            );
            commitAssistantRetry(assistantText.visible);
            deps.messages.push(
              deps.recoveryUserMessage(
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
          deps.loop.malformedNativeArgsRounds = 0;
        }
      }


      const completionBudget = routeCompletionBudget({
        provider: deps.loop.provider,
        model: deps.loop.model,
        stepMaxTokens: deps.loop.stepMaxTokens,
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
          truncatedBudgetRounds: deps.loop.truncatedBudgetRounds,
          continuationBudgetFloor: deps.loop.continuationBudgetFloor,
          retryWithoutThinking: deps.loop.retryWithoutThinking,
          interruptedVisible: deps.loop.interruptedVisible,
          interruptedReasoning: deps.loop.interruptedReasoning,
          lowYieldResumptions: deps.loop.lowYieldResumptions,
          visibleCommitted: deps.outputState.visibleCommitted,
        };
        const budgetDecision = handleOutputBudgetExhaustion(
          {
            messages: deps.messages,
            provider: deps.loop.provider,
            model: deps.loop.model,
            stepMaxTokens: deps.loop.stepMaxTokens,
            maxStepCompletionTokens: MAX_STEP_COMPLETION_TOKENS,
            notify: deps.writeNotice,
            recoveryUserMessage: deps.recoveryUserMessage,
            pushAssistantHistory: (historyText) =>
              deps.pushAssistantHistory(historyText, retryReasoning),
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
        deps.loop.truncatedBudgetRounds = budgetState.truncatedBudgetRounds;
        deps.loop.continuationBudgetFloor = budgetState.continuationBudgetFloor;
        deps.loop.retryWithoutThinking = budgetState.retryWithoutThinking;
        deps.loop.interruptedVisible = budgetState.interruptedVisible;
        deps.loop.interruptedReasoning = budgetState.interruptedReasoning;
        deps.loop.lowYieldResumptions = budgetState.lowYieldResumptions;
        deps.outputState.visibleCommitted = budgetState.visibleCommitted;
        if (budgetDecision === "continue-round") continue;
        if (budgetDecision === "stop-partial") {
          return deps.finishTurn(
            "The model exhausted its output budget again after one preserved continuation. No visible answer was produced.",
            deps.loop.step + 1,
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
            deps.writeToolBlocked(deferred.eventId, deferred.call.name, reason);
          }
          markTextOnlyModel(deps.loop.provider, deps.loop.model);
          deps.writeNotice(
            "warn",
            "provider abandoned a native tool call — switching this model to the text tool protocol",
          );
        }
        const emptyState: EmptyResponseState = {
          emptyVisibleRetries: deps.loop.emptyVisibleRetries,
          retryWithoutThinking: deps.loop.retryWithoutThinking,
          interruptedReasoning: deps.loop.interruptedReasoning,
        };
        const emptyDecision = handleEmptyResponse(
          {
            messages: deps.messages,
            toolsAttached,
            planModeWithoutPlan: deps.isPlanMode && !deps.activePlan,
            notify: deps.writeNotice,
            commitAssistantRetry,
            recoveryUserMessage: deps.recoveryUserMessage,
          },
          emptyState,
          {
            assistantVisible: assistantText.visible,
            assistantThinkContent: assistantText.thinkContent,
            hasThinking: assistantText.hasThinking,
            incompleteNativeStream,
          },
        );
        deps.loop.emptyVisibleRetries = emptyState.emptyVisibleRetries;
        deps.loop.retryWithoutThinking = emptyState.retryWithoutThinking;
        deps.loop.interruptedReasoning = emptyState.interruptedReasoning;
        if (emptyDecision === "continue-round") continue;
        return deps.finishTurn("Model returned an empty response after retries.", deps.loop.step + 1);
      } else {
        deps.loop.emptyVisibleRetries = 0;
        deps.loop.truncatedBudgetRounds = 0;
        deps.loop.continuationBudgetFloor = 0;
        deps.loop.retryWithoutThinking = false;
        deps.loop.interruptedReasoning = "";
      }


      let bareArgsOnly = false;
      recoveredFromBareJson = false;
      if (!call) {
        const bare = recognizeBareToolJson(assistantText.visible);
        if (bare?.call) {
          call = bare.call;
          recoveredFromBareJson = true;
          deps.writeNotice(
            "info",
            "recovered an unfenced tool call from bare JSON",
          );
        } else if (bare?.argsOnly) {
          bareArgsOnly = true;
        }
      }
      if (!call && assistantText.hasThinking) {
        const bareThink = recognizeBareToolJson(assistantText.thinkContent);
        if (bareThink?.call) {
          call = bareThink.call;
          recoveredFromBareJson = true;
          deps.writeNotice(
            "info",
            "recovered an unfenced tool call from thinking content",
          );
        } else if (bareThink?.argsOnly) {
          bareArgsOnly = true;
        }
      }
      if (!call) {
        const answer = await resolveAnswerPath(deps, {
          assistantText,
          canonicalAssistantVisible,
          bareArgsOnly,
          toolsAttached,
          commitAssistantRetry,
        });
        if (answer.kind === "finished") return answer.outcome;
        continue;
      }

      const toolDisplayText = deps.loop.interruptedVisible
        ? canonicalAssistantVisible
        : assistantText.visible;
      const beforeTool = recoveredFromBareJson
        ? ""
        : nativeToolCalls.length
          ? toolDisplayText.trim()
          : textBeforeToolCall(toolDisplayText);
      if (beforeTool) {
        deps.writeAssistantMessage(beforeTool);
      } else {
        deps.emit({ type: "assistant-message", text: "" });
      }
      deps.loop.interruptedVisible = "";
      deps.loop.interruptedReasoning = "";
      deps.loop.lowYieldResumptions = 0;

      let bound = bindToolCalls({
        nativeToolCalls,
        visible: assistantText.visible,
        thinkContent: assistantText.thinkContent,
        primaryCall: call,
      });

      const deferral = decidePlanCallDeferral(bound);
      let toRun = bound.slice(0, deferral.runCount);
      let activeDeferredToolCalls = deferredToolCalls.slice(
        0,
        deferral.runCount,
      );
      const deferReason = deferral.deferReason;
      if (deferral.notice) deps.writeNotice("info", deferral.notice);
      if (deferral.systemMessage) {
        deps.messages.push({ role: "system", content: deferral.systemMessage });
      }


      const reconciled = reconcileToolCallIds(bound, toRun, deps.messages);
      const historyNativeCalls = reconciled.historyNativeCalls;
      bound = reconciled.bound;
      toRun = reconciled.toRun;
      const allCalls = toRun.map((b) => b.call);
      const actionSequenceCalls = bound.map((entry) => {
        const candidate = entry.call;
        const stateKey = deps.probeStateKey(candidate);
        return {
          name: candidate.name,
          args: candidate.args,
          ...(stateKey ? { stateKey } : {}),
        };
      });
      const callToBound = new Map<ToolCall, BoundCall>(
        toRun.map((b) => [b.call, b]),
      );
      const runIds = new Set(toRun.map((b) => b.id));
      const sequenceDecision = deps.loopGuard.observeActionSequence(actionSequenceCalls);

      if (sequenceDecision.suppress) {
        const suppression = suppressRepeatedActionSequence(
          {
            messages: deps.messages,
            notify: deps.writeNotice,
            queuedEventId: (index) => deferredToolCalls[index]?.eventId,
            allocateEventId: () => deps.nextToolEventId(),
            writeToolCall: deps.writeToolCall,
            markPrinted: (eventId) => deps.alreadyPrintedIds.add(eventId),
            emitToolStart: (eventId) =>
              deps.emit({ type: "tool-start", id: eventId }),
            writeToolOutput: (eventId, chunk) =>
              deps.writeToolOutput(eventId, chunk),
            emitToolResult: deps.emitToolResult,
            priorObservation: (priorCall) =>
              deps.loopGuard.getPriorObservation(priorCall.name, priorCall.args),
            pushAssistantHistory: (text) =>
              deps.pushAssistantHistory(text, completion),
            upsertActionCycleRecovery: deps.upsertActionCycleRecovery,
            unreadResponderResults: () => deps.responderClaims.size > 0,
            currentSignature: () =>
              deps.loopGuard.currentActionSequenceSignature(),
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
          deps.outcomeState.outcome.status = "partial";
          await saveOutcomeState(deps.outcomeState);
          deps.moveTurn("partial", "repeated identical action sequence");
          return deps.finishTurn(
            suppression.answer,
            deps.counters.productiveSteps,
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
        deps.writeNotice("warn", sequenceDecision.warnMessage);
        deps.messages.push(
          deps.recoveryUserMessage(sequenceDecision.warnMessage),
        );
      }

      if (allCalls.length > 1) {
        deps.writeNotice(
          "info",
          `${allCalls.length} tool calls in this message — read-only in parallel, writes in order (failures do not cancel siblings)`,
        );
      }


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
          deps.writeToolCall(deferred.eventId, deferred.call);
          deferred.shown = true;
        }
      }

      if (historyNativeCalls.length) {
        appendAssistantWithTools(
          deps.messages,
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
        deps.pushAssistantHistory(standardizedContent, completion);
      }


      const scopeForBatch = await loadScopeForSession(deps.session.sessionId).catch(
        () => undefined,
      );

      const isParallelSafe = (c: ToolCall): boolean => {
        if (deps.mcpRuntime?.isParallelSafe(c.name)) return true;
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
      const PARALLEL_LIMIT = 8;

      const round = createRoundState(
        Boolean(deps.activePlan && deps.activePlan.tasks.length > 0),
        allCalls.length,
      );

      const planRemindedAt = new Set<number>();
      const toolResultRecorder = createToolResultRecorder({
        messages: deps.messages,
        useNativeToolHistory: historyNativeCalls.length > 0,
        deferredPostToolMessages: deps.deferredPostToolMessages,
        seenHashes: deps.toolResultHashes,
        remindedAt: planRemindedAt,
        writeNotice: deps.writeNotice,
      });

      const record = createRoundRecorder({
        round,
        counters: deps.counters,
        evidenceFlags: deps.evidenceFlags,
        recovery: deps.recovery,
        isPlanMode: deps.isPlanMode,
        pentestTurn: deps.pentestLike || deps.pentestSession,
        planApproved: () => deps.session.planApproved.value,
        approvePlan: () => {
          deps.session.planApproved.value = true;
        },
        priorObservation: (priorCall) =>
          deps.loopGuard.getPriorObservation(priorCall.name, priorCall.args),
        projectRoot: getActiveProjectRoot,
        kindHint: () =>
          deps.activePlan?.kind === "pentest" || deps.pentestLikeTurn
            ? "pentest"
            : deps.activePlan?.kind === "coding"
              ? "coding"
              : "general",
        recordHistory: (entry) => toolResultRecorder.record(entry),
        onPlanCreated: (planKind) => {
          deps.loop.codingSession = codingSessionFromContext({ buildLike: deps.buildLike, planKind });
        },
      });
      const recordResult = (
        boundCall: BoundCall,
        res: RecordedToolResult,
      ): void => record(boundCall.id, res);

      {
        const livePlanForBatch = await loadPlan(deps.session.sessionId).catch(
          () => undefined,
        );
        const guard = evaluateTaskBatchGuard({
          calls: toRun.map((bound) => bound.call),
          plan: livePlanForBatch,
          pendingSignature: deps.session.pendingTaskBatch.value,
        });
        deps.loop.batchRemindCalls = new Set<ToolCall>(guard.remindCalls);
        deps.loop.batchReminderNote = guard.reminderNote;
        deps.session.pendingTaskBatch.value = guard.pendingSignature;
        for (const notice of guard.notices) {
          deps.writeNotice(notice.level, notice.message);
        }
      }

      const replayExecutedOccurrence = (
        bc: BoundCall,
        uiId: string,
      ): ReplayedOccurrence | undefined =>
        deps.wireOccurrences.replay(bc.wireId, bc.call, uiId);
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
      ): void => deps.wireOccurrences.remember(bc.wireId, res);

      const groups = groupToolCallsForExecution(
        allCalls,
        isParallelSafe,
        PARALLEL_LIMIT,
      );
      await executeToolGroups(
        {
          round,
          boundFor: (groupCall) => callToBound.get(groupCall),
          eventIdFor: (bound) => {
            if (!callIds[bound.index]) {
              callIds[bound.index] = deps.nextToolEventId();
            }
            return callIds[bound.index]!;
          },
          replay: replayExecutedOccurrence,
          execute: (groupCall, uiId) =>
            deps.executeSingleTool(
              groupCall,
              uiId,
              deps.options.signal || new AbortController().signal,
            ),
          record: recordResult,
          remember: rememberExecutedOccurrence,
        },
        groups,
      );

      settleUnrunCalls(
        {
          round,
          messages: deps.messages,
          useNativeHistory: historyNativeCalls.length > 0,
          eventIdFor: (index) => {
            if (!callIds[index]) {
              callIds[index] = deps.nextToolEventId();
            }
            return callIds[index]!;
          },
          wasPrinted: (uiId) => deps.alreadyPrintedIds.has(uiId),
          emitToolResult: deps.emitToolResult,
        },
        toRun,
      );

      const closeoutState = { consecutiveSynthesizedRounds: deps.loop.consecutiveSynthesizedRounds };
      const closeout = await closeOutRound(
        {
          messages: deps.messages,
          recordedNativeIds: round.recordedNativeIds,
          historyNativeCalls,
          deferReason,
          priorObservation: (priorCall) =>
            deps.loopGuard.getPriorObservation(priorCall.name, priorCall.args),
          completeActionSequence: (eligible, outcome) =>
            deps.loopGuard.completeActionSequence(
              actionSequenceCalls,
              eligible,
              outcome,
            ),
          currentSignature: () => deps.loopGuard.currentActionSequenceSignature(),
          drainResponderLedger: () =>
            deps.deferredResponderLedgerNotifications.splice(0),
          refreshInstructions: async () => {
            deps.evidenceFlags.instructionsChangedThisRound = false;
            await deps.refreshAgentInstructions();
          },
          refreshSessionState: deps.refreshSessionState,
          recoveryUserMessage: deps.recoveryUserMessage,
          drainDeferredMessages: () => deps.deferredPostToolMessages.splice(0),
        },
        closeoutState,
        {
          bound,
          runIds,
          outcomes: round.actionSequenceOutcomes,
          sequenceEligible: round.actionSequenceEligible,
          executedCount: round.actionSequenceExecuted,
          plannedCount: allCalls.length,
          runCount: toRun.length,
          suppressedCount: round.roundSuppressedCount,
          aborted: round.aborted,
          awaitingPlanApproval: round.awaitingPlanApproval,
          instructionsChanged: deps.evidenceFlags.instructionsChangedThisRound,
          pendingSessionStatePlan: deps.toolState.pendingSessionStatePlan,
          responderWakeTurn: deps.responderWakeTurn,
          unreadResponderResults: deps.responderClaims.size > 0,
          calledResponderRead: allCalls.some(
            (candidate) =>
              candidate.name === "job.read" || candidate.name === "task.read",
          ),
        },
      );
      deps.loop.consecutiveSynthesizedRounds = closeoutState.consecutiveSynthesizedRounds;
      if (closeout.kind === "stop") {
        deps.outcomeState.outcome.status = "partial";
        await saveOutcomeState(deps.outcomeState);
        deps.moveTurn("partial", "repeated identical action cycle");
        return deps.finishTurn(
          closeout.answer,
          deps.counters.productiveSteps,
          "partial",
          closeout.remainingCriteria,
          closeout.reason,
          undefined,
          closeout.loopGuardStop,
        );
      }

      if (round.awaitingPlanApproval) {
        deps.loop.pendingCalls = [];
        deps.outcomeState.outcome.status = "partial";
        await saveOutcomeState(deps.outcomeState);
        deps.moveTurn("partial", "draft plan awaits approval");
        return deps.finishTurn(
          "",
          deps.counters.productiveSteps,
          "partial",
          ["Approve or revise the draft plan before implementation."],
        );
      }

      if (round.aborted) {
        deps.loop.lastAnswer = "";
        deps.outcomeState.outcome.status = "aborted";
        await saveOutcomeState(deps.outcomeState);
        deps.moveTurn("aborted", "turn aborted");
        deps.writeAbort();
        return deps.finishTurn(deps.loop.lastAnswer, deps.counters.productiveSteps, "aborted");
      }

      await deps.maybeAutoCompact("post-tool-token-budget");

      if (deps.options.onMessages) {
        try {
          deps.options.onMessages(buildTurnHistory(deps.liveMessages(), deps.loop.lastAnswer));
        } catch {
        }
      }
    }
  }


  const richSummary = await buildRichStopSummary(
    deps.messages,
    deps.session,
    deps.counters.productiveSteps,
  );
  deps.loop.lastAnswer = richSummary;
  deps.outcomeState.outcome.status = "paused_budget";
  await saveOutcomeState(deps.outcomeState);
  deps.moveTurn("paused_budget", "emergency iteration ceiling reached");
  return deps.finishTurn(
    deps.loop.lastAnswer,
    deps.counters.productiveSteps,
    "paused_budget",
    ["Continue unfinished work in a subsequent turn."],
    "The emergency iteration ceiling was reached.",
  );
};
