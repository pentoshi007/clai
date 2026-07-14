import chalk from "chalk";
import { homedir } from "node:os";

import { join, relative, resolve } from "node:path";
import type {
  ChatMessage,
  ChatImage,
  ProviderId,
  ToolCall,
  ToolResult,
} from "../types.js";
import { streamWithProvider, completeWithProvider } from "../llm/router.js";
import { randomUUID } from "node:crypto";
import { jobManager, type BackgroundJob } from "../tools/jobs.js";
import {
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
  scratchDirFor,
} from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { groqInputTokenBudget } from "../llm/groq.js";
import {
  classifyToolCall,
  isPentestToolCall,
  scopeHint,
  scopeTargetForToolCall,
} from "../safety/classifier.js";
import {
  availableToolNames,
  normalizeToolCall,
  runToolCall,
  BATCH_SAFE_TOOLS,
} from "../tools/registry.js";
import { looksInteractiveStdin } from "../tools/shell.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import {
  compactMessagesWithSummary,
  estimateTokens,
  estimateMessagesTokens,
  COMPACTION_MEMORY_PREFIX,
} from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive, targetInScope } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
  renderThinkingSummary,
  stripThinking,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner, type ThinkingSpinner } from "../ui/spinner.js";
import { safeCwd } from "../os/cwd.js";
import { analyzeTask } from "./task-analyzer.js";
import { LoopGuard } from "./loop-guard.js";
import { loadPlan, type SessionPlan } from "../store/plan.js";
import type { AgentEvent } from "./events.js";
import { pathInsideSandbox, fsWrite } from "../tools/fs.js";
import {
  stripSentinelTokens,
  parseToolCall,
  recognizeBareToolJson,
  looksLikeTruncatedToolCall,
  salvageTruncatedWrite,
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
  looksLikeActionNarration,
  looksLikePlanNarration,
  requiresFreshWebSearch,
  freshnessGuardMessage,
  buildWorkflowDirective,
  pentestWorkflowDirective,
  shouldDimToolChatter,
  looksLikePromptLeak,
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
  saveToolOutput,
  summarizeOutput,
  formatToolContext,
} from "./tool-output-formatting.js";
import {
  renderPlanForTerminal,
  planContextMessage,
  handlePlanTool,
} from "./plan-tool.js";
import {
  inquirerConfirmPort,
  restoreInteractiveStdin,
  ensurePentestAuthorization,
  confirmToolExecution,
  type ConfirmPort,
} from "./confirm-port.js";
import { buildRichStopSummary } from "./stop-summary.js";

// Re-exported so existing imports of these names from "./runner.js" keep
// working unchanged — the parsing/classification engine now lives in
// tool-call-parser.ts, and the session/plan/confirm/formatting helpers now
// live in their own dedicated modules.
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
 * Tool names that may write into the project tree. Writes restricted to the
 * per-project scratch directory (under tmpdir()/clai/<name>) are exempted
 * from the active-plan and plan-approved gates so the model can use scratch
 * space to build / inspect / stage work without first creating a plan.
 */
const SCRATCH_WRITABLE_TOOLS = new Set([
  "fs.write",
  "fs.writeMany",
  "fs.edit",
  "fs.replaceLines",
  "fs.append",
  "fs.delete",
]);

/**
 * Expand `~` the same way `src/tools/fs.ts` does so callers can compare an
 * already-expanded scratch path against paths supplied by the model.
 */
function expandHomeLocal(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/**
 * Extract the target path(s) a write-shaped tool call would touch. Returns
 * an empty array when the call has no resolvable path (so the caller can
 * treat it as NOT scratch-only and fall through to the normal gates).
 */
function scratchWriteTargetPaths(call: ToolCall): string[] {
  if (call.name === "fs.writeMany") {
    const files = call.args.files;
    if (!Array.isArray(files)) return [];
    const paths: string[] = [];
    for (const entry of files) {
      if (entry && typeof entry === "object" && "path" in entry) {
        const p = (entry as { path?: unknown }).path;
        if (typeof p === "string" && p.length > 0) paths.push(p);
      }
    }
    return paths;
  }
  const pathArg = call.args.path;
  if (typeof pathArg !== "string" || pathArg.length === 0) return [];
  return [pathArg];
}

/**
 * True iff every target path this call would write is inside the resolved
 * scratch directory. A path is considered inside when its `path.relative`
 * against the scratch root is empty (the scratch root itself) or does not
 * start with `..` (no parent traversal). Calls without a recognizable
 * target path return false so they fall through to the normal gates.
 */
function isScratchOnlyWrite(call: ToolCall, scratchDir: string): boolean {
  if (!SCRATCH_WRITABLE_TOOLS.has(call.name)) return false;
  const paths = scratchWriteTargetPaths(call);
  if (paths.length === 0) return false;
  const resolvedScratch = resolve(scratchDir);
  return paths.every((raw) => {
    const expanded = expandHomeLocal(raw);
    const resolved = resolve(expanded);
    const rel = relative(resolvedScratch, resolved);
    return rel === "" || (!rel.startsWith("..") && rel !== "..");
  });
}

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  images?: ChatImage[] | undefined;
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
  confirm?: ConfirmPort | undefined;
  requestSecret?:
    | ((request: {
        title: string;
        prompt: string;
      }) => Promise<string | undefined>)
    | undefined;
  session?: SessionPolicy | undefined;
}

export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  const writesDirectly = !options.onEvent;
  const emit = (event: AgentEvent): void => options.onEvent?.(event);
  const noopSpinner: ThinkingSpinner = {
    setLabel: () => {},
    bumpReasoning: () => {},
    pushPreview: () => {},
    stop: () => {},
  };
  const writeStatus = (text: string, rendered = chalk.dim(text)): void => {
    emit({ type: "status", text });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeNotice = (
    level: "info" | "warn",
    text: string,
    rendered: string,
  ): void => {
    emit({ type: "notice", level, text });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAssistantMessage = (text: string): void => {
    emit({ type: "assistant-message", text });
    const rendered = renderMarkdown(text);
    if (writesDirectly) {
      process.stdout.write(text.endsWith("\n") ? rendered : `${rendered}\n`);
    }
  };
  const writeThinkingBlock = (content: string): void => {
    emit({ type: "thinking-block", content });
    if (writesDirectly)
      process.stdout.write(`${renderThinkingSummary(content)}\n`);
  };
  const writeToolOutput = (
    id: string,
    chunk: string,
    rendered: string,
  ): void => {
    emit({ type: "tool-output", id, chunk });
    if (writesDirectly) process.stdout.write(rendered);
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
  const writePlanUpdate = (plan: SessionPlan, rendered: string): void => {
    emit({ type: "plan-update", plan });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeToolBlocked = (
    id: string,
    name: string,
    reason: string,
    rendered: string,
  ): void => {
    emit({ type: "tool-blocked", id, name, reason });
    if (writesDirectly) process.stdout.write(rendered);
  };
  const writeAbort = (): void => {
    emit({ type: "turn-aborted" });
    if (writesDirectly) process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
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
    emit(event);
  };
  /** Strip a known prefix from a string, returning the remainder unchanged. */
  const insertedText = (value: string, prefix: string): string =>
    value.startsWith(prefix) ? value.slice(prefix.length) : value;
  /**
   * Surface the compacted-context summary to both the TUI (via an event)
   * and, when running with a direct stdout writer, as a rendered box.
   * Token-count stats are always emitted for logs.
   */
  const writeCompacted = (
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ): void => {
    emit({ type: "compacted", summary, beforeTokens, afterTokens });
    if (writesDirectly) {
      const header = chalk.dim("  \u2726 Compacted Context");
      const footer = chalk.dim(
        `  ~${beforeTokens.toLocaleString()} \u2192 ~${afterTokens.toLocaleString()} tokens`,
      );
      const body = summary ? renderMarkdown(summary) : "(empty summary)";
      process.stdout.write(`${header}\n\n${body}\n${footer}\n`);
    }
  };
  // Points at the live message array so finishTurn can hand the full
  // conversation back to the caller. Assigned once `messages` is built below;
  // all later mutations are in-place so this reference stays current.
  let liveMessages: ChatMessage[] = [];
  const finishTurn = (answer: string, steps: number): string => {
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, answer));
      } catch {
        // Persisting history must never break the turn.
      }
    }
    emit({ type: "turn-end", finalAnswer: answer, steps });
    return answer;
  };

  try {
    emit({ type: "turn-start", prompt });
    const config = getConfig();
    const maxSteps = options.maxSteps ?? 70;
    const confirmPort = options.confirm ?? inquirerConfirmPort;
    const projectContext = await loadProjectContext();
    const hasAttachedImages = Boolean(options.images?.length);
    const imageOcrEnabled = shouldEnableImageOcr(prompt, hasAttachedImages);
    // A vision-capable request already carries the actual image bytes. Hiding
    // image.ocr from the model prevents it from replacing visual inspection
    // with a lossy Tesseract pass (which produced fabricated screenshot text).
    const toolNames = availableToolNames().filter(
      (name) => name !== "image.ocr" || imageOcrEnabled,
    );
    // Build / scaffold / continuation turns must NEVER be diverted into a
    // web.search for "current info". The /implement directive ("Execute it
    // now…") and prompts like "create a react app" contain words such as
    // "now"/"latest" that trip the volatile-info regex; without this guard the
    // agent burns its turn searching the date instead of writing files.
    const buildLikeTurn = looksLikeBuildTask(prompt, options.history);
    const pentestLikeTurn = looksLikePentestTask(prompt, options.history);
    // A plain informational follow-up ("what do you know so far", "summarize
    // the findings") in a resumed/continuing build or pentest session must
    // NOT inherit that session's "must act" behavior — it should be answered
    // from context, not treated as a signal to start executing or to invent a
    // brand-new plan (the exact failure where "what do u know till now"
    // triggered explore→plan and created an unrelated "Enhance clai" plan).
    const informationalQuery = looksLikeInformationalQuery(prompt);
    const freshWebSearchRequired =
      !buildLikeTurn &&
      !pentestLikeTurn &&
      toolNames.includes("web.search") &&
      requiresFreshWebSearch(prompt);
    let provider = options.provider ?? config.defaultProvider;
    await ensureProviderConfigured(provider);
    let model = options.model ?? config.defaultModel;
    // Some Groq free-tier models have a per-request/per-minute input budget
    // below the normal agent prompt alone. Select a purpose-built compact
    // instruction set before the request is made, rather than treating the
    // provider's 413 as a context-window failure after the fact.
    const inputTokenBudget =
      provider === "groq" ? groqInputTokenBudget(model) : undefined;
    const useCompactSystemPrompt = inputTokenBudget !== undefined;
    const systemSections = [
      (useCompactSystemPrompt
        ? renderCompactAgentSystemPrompt
        : renderAgentSystemPrompt)(toolNames.join(", ")),
    ];
    if (projectContext) {
      systemSections.push(
        `Project context from .clai/context.md:\n${projectContext}`,
      );
    }
    if (freshWebSearchRequired) {
      systemSections.push(freshnessGuardMessage());
    }

    let lastAnswer = "";
    const session: SessionPolicy = options.session ?? createSessionPolicy();

    // Active plan context
    // If this session already has a plan, inject it so the model keeps it in
    // context. When the user has approved it (via /implement) we instruct the
    // agent to execute task by task; otherwise the agent should refine/wait.
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    if (activePlan) {
      // session.planApproved is in-memory only (never persisted), so a
      // resumed session (via /history) or a fresh SessionPolicy after
      // context compaction always starts it back at false — even when the
      // plan's OWN durable status shows it was already approved/executed/
      // completed via /implement. Re-derive the flag from the plan's status
      // on every load so resuming a session never re-blocks tool calls
      // behind a stale "awaiting approval" gate for a plan that already ran.
      if (isPlanApprovedByStatus(activePlan.status)) {
        session.planApproved.value = true;
      }
      systemSections.push(
        planContextMessage(activePlan, session.planApproved.value),
      );
    }

    // For build/scaffold turns with no active plan yet, inject an explicit
    // workflow so the agent does NOT rush to write files in one shot. It must
    // explore the directory, read the relevant existing files to understand
    // what's already there, create a comprehensive multi-task plan, then
    // implement task by task until the goal is met. This mirrors how a careful
    // coding agent (Claude Code) operates.
    if (buildLikeTurn && !activePlan && !informationalQuery) {
      systemSections.push(buildWorkflowDirective());
    }

    // Pentest / security engagements need a different shape than a coding
    // build: recon first, then a plan built from real findings, then
    // incremental task additions as new attack surface appears. The
    // directive is only injected before a plan exists; once a plan is in
    // place (or being refined), the ACTIVE PLAN block already carries the
    // current task state and recon-vs-active-tool guidance.
    if (pentestLikeTurn && !activePlan && !informationalQuery) {
      systemSections.push(pentestWorkflowDirective());
    }

    const renderedSystemPrompt = systemSections.join("\n\n");
    // Reserve most of a constrained model's input budget for the user message,
    // recent conversation, tool results, and provider framing. Dynamic project
    // context or a saved plan must not silently grow the compact base prompt
    // back above the model's TPM ceiling.
    const maxSystemTokens = inputTokenBudget
      ? Math.min(2_000, Math.floor(inputTokenBudget * 0.4))
      : undefined;
    const systemTruncationNote =
      "\n\n[Additional system context omitted to fit the provider input budget.]";
    const fullSystemPrompt =
      maxSystemTokens !== undefined &&
      estimateTokens(renderedSystemPrompt) > maxSystemTokens
        ? renderedSystemPrompt.slice(
            0,
            Math.max(
              0,
              Math.floor(maxSystemTokens * 3.3) - systemTruncationNote.length,
            ),
          ) + systemTruncationNote
        : renderedSystemPrompt;
    const userMessage: ChatMessage = { role: "user", content: prompt };
    if (options.images && options.images.length > 0) {
      userMessage.images = options.images;
    }
    const messages: ChatMessage[] = [
      { role: "system", content: fullSystemPrompt },
      ...(options.history ?? []),
      userMessage,
    ];
    liveMessages = messages;
    const recoveryUserMessage = (content: string): ChatMessage => {
      const message: ChatMessage = { role: "user", content };
      if (options.images && options.images.length > 0) {
        // Some OpenAI-compatible gateways/models attend most strongly to the
        // latest user turn. Keep the image attached on recovery nudges so a
        // thinking-only retry does not degrade into OCR/tool guessing.
        message.images = options.images;
      }
      return message;
    };
    // Every provider must receive a syntactically valid assistant turn between
    // the original user prompt and a recovery nudge. In particular, Gemini
    // serializes an empty assistant message as an empty `model` text part,
    // which can cause every retry to return empty as well. Keep hidden thinking
    // out of history, but record a compact non-empty sentinel when there was no
    // visible output.
    const pushAssistantHistory = (content: string): void => {
      messages.push({
        role: "assistant",
        content: content.trim()
          ? content
          : "[No visible assistant response was produced.]",
      });
    };

    // Track recent tool calls to detect models stuck in a loop calling the
    // same tool with the same arguments over and over (e.g. pentest.recon
    // called 3× on the same target without summarizing).
    const loopGuard = new LoopGuard();

    // Track consecutive thinking-only responses so we can nudge the model
    // to actually act instead of silently returning an empty answer.
    let emptyVisibleRetries = 0;
    // A model that spent an entire completion in hidden reasoning gets one
    // visible-output retry with provider thinking disabled. This is per-turn
    // only: a subsequent successful response restores the configured setting.
    let retryWithoutThinking = false;

    // Track tool calls truncated by the token limit so we can ask the model
    // to retry in smaller pieces instead of leaking broken JSON as an answer.
    let truncatedToolRetries = 0;

    // Track bare-args JSON tool calls (missing the {name,args} wrapper / fence)
    // so we can nudge the model to re-emit a proper fenced call a few times
    // before giving up, instead of leaking the JSON as a final answer.
    let bareToolJsonRetries = 0;

    // Track a ```tool fence that is present but whose JSON could not be parsed
    // (e.g. malformed extra/missing braces that are NOT simple truncation). We
    // retry instead of leaking the raw block as the final answer.
    let malformedFenceRetries = 0;

    // For volatile live-info prompts, make one corrective pass if a model
    // ignores the freshness guard and tries to answer from stale memory.
    let sawFreshWebSearch = false;
    let freshnessRetryUsed = false;

    // Guard against a model that declares an approved plan "complete" while
    // tasks are still pending and it never ran the work. We nudge it back to
    // executing the next task a bounded number of times before giving up.
    let prematureCompletionRetries = 0;
    let runtimeVerificationRetries = 0;
    let sawServerStart = false;
    let sawServerTail = false;
    let sawLocalHttpProbe = false;

    // Guard against a model that NARRATES intent ("let me explore the
    // directory…") but emits no tool call, so nothing runs and the turn ends
    // prematurely. On build/scaffold/plan turns where nothing has executed yet,
    // we nudge it to emit a real tool call instead of accepting the narration
    // as a final answer. Bounded so a model that truly can't emit the format
    // still terminates.
    let actionIntentRetries = 0;

    // Multi-tool execution queue
    // Models naturally emit several tool calls in one message — e.g. the
    // plan-execution rhythm "task.update in_progress → do the work →
    // task.update done", or a batch of fs.write calls. Rather than running
    // only the first and discarding the rest (which made models believe work
    // ran when it didn't, and broke plan execution), we parse ALL calls in a
    // message, run the first this iteration, and queue the rest here to run on
    // subsequent iterations WITHOUT another model round-trip. The queue is
    // cleared whenever a call fails, is blocked, or needs the model to react,
    // so the model always sees errors and stays in control.
    let pendingCalls: ToolCall[] = [];

    // Step budget
    // The budget governs how many *productive* steps (a tool execution or a
    // final answer) the agent may take. Recovery iterations — nudging a model
    // that only produced thinking, asking it to re-emit a malformed tool call,
    // a freshness retry, or a loop-guard summary — do NOT consume this budget;
    // they get a separate hard ceiling so a wedged model can't spin forever.
    //
    // Complexity is a coarse signal from prompt length, but short follow-up
    // prompts ("do it", "build fully on your own", "app is not complete") in
    // the middle of a multi-file build must NOT be capped like a one-shot
    // lookup — that was the reason a React scaffold stopped half-built after
    // 10 steps. We bump the budget when the prompt (or recent history) looks
    // like a build/scaffold or a continuation of one.
    const analysis = analyzeTask(prompt);
    const hasHistory = (options.history?.length ?? 0) > 0;
    const buildLike = buildLikeTurn;
    const pentestLike = looksLikePentestTask(prompt, options.history);
    let stepBudget =
      analysis.complexity === "simple"
        ? 20
        : analysis.complexity === "standard"
          ? 40
          : maxSteps;
    if (buildLike || pentestLike) {
      // Scaffolding / multi-file work / pentest tasks need room.
      // Continuation prompts ("do it") inherit this too.
      stepBudget = Math.max(stepBudget, maxSteps);
    } else if (hasHistory) {
      // A follow-up to an ongoing task should never be capped tighter than a
      // standard one-shot, even if it's only a couple of words.
      stepBudget = Math.max(stepBudget, 40);
    }
    // Hard ceiling on total loop iterations (productive + recovery) so a model
    // stuck emitting only thinking or malformed calls can't loop indefinitely.
    let maxIterations = stepBudget * 3;

    let productiveSteps = 0;
    let step = -1;
    let nextToolEventId = 0;
    const alreadyPrintedIds = new Set<string>();

    const promptMutex = {
      promise: Promise.resolve(),
      async acquire(): Promise<() => void> {
        let release = () => {};
        const next = new Promise<void>((r) => {
          release = r;
        });
        const current = this.promise;
        this.promise = current.then(() => next);
        await current;
        return release;
      },
    };

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
      blockOrCancel?: boolean | undefined;
    }> {
      // Resolved once per call so the scratch-only exemption can compare the
      // model-supplied paths against the canonical per-project scratch root.
      const scratchDir = scratchDirFor(safeCwd());
      let call = normalizeToolCall(rawCall);

      if (call.name === "image.ocr" && !imageOcrEnabled) {
        writeNotice(
          "info",
          "skipped OCR because the original image is attached to the vision model",
          chalk.dim(
            "  ℹ skipped OCR — inspecting the attached image directly\n",
          ),
        );
        const recoveryText =
          "The original image is attached to this message and you can inspect it directly. " +
          "Do not call image.ocr or infer text from OCR. Answer the user's question from the actual image pixels now.";
        const result = { ok: true, output: recoveryText };
        return { ok: true, call, result, contextOutput: recoveryText };
      }

      const loopCheck = loopGuard.shouldBlock(call.name, call.args);
      if (loopCheck.block) {
        const isWrite =
          call.name === "fs.write" ||
          call.name === "fs.writeMany" ||
          call.name === "fs.edit" ||
          call.name === "fs.replaceLines" ||
          call.name === "fs.append";
        const reason = `${call.name} was already called with the same arguments — ${isWrite ? "moving on" : "forcing summary"}`;
        writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
        const result = { ok: false, output: reason, exitCode: 1 };
        return {
          ok: false,
          call,
          result,
          contextOutput: reason,
          blockOrCancel: true,
        };
      }
      if (loopCheck.reason) {
        writeNotice(
          "info",
          loopCheck.reason,
          chalk.dim(`  ℹ ${loopCheck.reason}\n`),
        );
      }

      if (call.name === "plan.create" || call.name === "task.update") {
        const planResult = await handlePlanTool(call, session, {
          loopGuard,
          step,
        });
        if (planResult.handled) {
          loopGuard.recordAttempt(step, call.name, call.args, planResult.ok, 0);

          if (!alreadyPrintedIds.has(toolEventId)) {
            const toolCallLine =
              chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
            writeToolCall(
              toolEventId,
              call,
              styleToolChatter(call, toolCallLine) + "\n",
            );
            alreadyPrintedIds.add(toolEventId);
          }

          if (planResult.plan) {
            writePlanUpdate(planResult.plan, planResult.display);
          }

          const result = { ok: planResult.ok, output: planResult.modelNote };
          emitToolResult(toolEventId, result, planResult.modelNote);
          const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
          writeToolOutput(
            toolEventId,
            result.ok ? "ok\n" : "failed\n",
            statusIcon + "\n",
          );

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

      const isMutatingAction =
        (decision.level === "confirm" || decision.level === "block") &&
        !isPreApprovalAllowedTool(call.name) &&
        !isScratchOnlyWrite(call, scratchDir);

      if (isMutatingAction) {
        if (activePlan && !session.planApproved.value) {
          const reason = `plan awaiting approval — ${call.name} is blocked until you /implement (or /discard)`;
          writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
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

      // Task-scoped execution gate
      // Once a plan is approved, every non-plan tool call must run while
      // exactly one task is "in_progress". This stops a model from batching
      // tool calls for many/all tasks in one turn and only touching task
      // state at the very end (or never) — the failure mode where a model
      // claimed most tasks "done" in prose without ever recording it in the
      // plan. Multiple tool calls per task are still fine; they just must be
      // bracketed by task.update in_progress → (work) → task.update done.
      if (session.planApproved.value) {
        const livePlanForGate = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlanForGate) {
          const unfinished = livePlanForGate.tasks.some(
            (t) => t.state === "pending" || t.state === "in_progress",
          );
          const inProgress = livePlanForGate.tasks.find(
            (t) => t.state === "in_progress",
          );
          if (unfinished && !inProgress) {
            const nextPending = livePlanForGate.tasks.find(
              (t) => t.state === "pending",
            );
            const reason = nextPending
              ? `${call.name} blocked — no task is in_progress. Call task.update {taskId:"${nextPending.id}", state:"in_progress"} before doing any work for it.`
              : `${call.name} blocked — no task is in_progress.`;
            writeNotice("warn", reason, chalk.yellow(`  ⚠ ${reason}\n`));
            const result = { ok: false, output: reason, exitCode: 1 };
            // Recoverable ordering mistake (NOT a user/session control gate):
            // feed the reason back so the model marks the task in_progress and
            // retries within the same turn, rather than ending the turn.
            return {
              ok: false,
              call,
              result,
              contextOutput:
                `${reason}\nThis tool did NOT run. Emit task.update {state:"in_progress"} for the task first, then the work.`,
            };
          }
        }
      }

      if (call.name === "web.search") {
        sawFreshWebSearch = true;
      }

      if (!alreadyPrintedIds.has(toolEventId)) {
        const toolCallLine =
          chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
        writeToolCall(
          toolEventId,
          call,
          styleToolChatter(call, toolCallLine) + "\n",
        );
        alreadyPrintedIds.add(toolEventId);
      }

      const scopeTarget = scopeTargetForToolCall(call);
      if (
        scopeTarget &&
        (!isScopeActive(scope) || !targetInScope(scopeTarget, scope))
      ) {
        writeNotice(
          "info",
          `scope optional: ${scopeHint(scopeTarget)}`,
          chalk.dim(`  scope optional: ${scopeHint(scopeTarget)}\n`),
        );
      }

      if (decision.level === "block") {
        writeToolBlocked(
          toolEventId,
          call.name,
          decision.reason,
          chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n",
        );
        const message = `Blocked: ${call.name} — ${decision.reason}`;
        const result = { ok: false, output: message, exitCode: 1 };
        // Safety classifier blocks are recoverable model mistakes: feed the
        // failed result back to the model and let it choose a safer next step
        // instead of ending the entire agent turn. Hard workflow gates
        // (plan not approved, task not in_progress, auth declined, aborts)
        // still use blockOrCancel above/below because continuing would violate
        // user/session control rather than merely correcting a bad command.
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
          writeToolBlocked(
            toolEventId,
            call.name,
            lastAnswer,
            chalk.red(`  ✗ ${lastAnswer}`) + "\n",
          );
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

        let forceManualConfirm = call.name === "fs.delete";
        if (
          call.name.startsWith("fs.") &&
          !isPreApprovalAllowedTool(call.name)
        ) {
          const pathArg =
            typeof call.args.path === "string" ? call.args.path : undefined;
          if (pathArg) {
            const expandHomeLocal = (p: string) =>
              p.startsWith("~/") || p.startsWith("~\\")
                ? join(homedir(), p.slice(2))
                : p === "~"
                  ? homedir()
                  : p;
            const resolved = resolve(expandHomeLocal(pathArg));
            const mode =
              call.name === "fs.read" ||
              call.name === "fs.list" ||
              call.name === "fs.search"
                ? "read"
                : "write";
            if (!pathInsideSandbox(resolved, mode)) {
              forceManualConfirm = true;
            }
          }
        }

        if (decision.level === "confirm" && !pentestJustConfirmed) {
          const ok = await confirmToolExecution(
            call,
            forceManualConfirm ? false : Boolean(options.autoConfirm),
            session,
            confirmPort,
          );
          restoreInteractiveStdin();
          if (!ok) {
            const lastAnswer = "Cancelled.";
            writeToolBlocked(
              toolEventId,
              call.name,
              lastAnswer,
              chalk.red(`  ✗ cancelled`) + "\n",
            );
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
      options.onToolStart?.(call);

      const interactiveCommand =
        (call.name === "shell.exec" &&
          typeof call.args.command === "string" &&
          looksInteractiveStdin(call.args.command)) ||
        call.name === "net.scan" ||
        call.name === "pentest.recon";
      if (interactiveCommand && process.stdin.isTTY) {
        writeNotice(
          "warn",
          "this command may prompt for a password — type it when asked",
          chalk.yellow(
            "  ⚠ this command may prompt for a password — type it when asked\n",
          ),
        );
      }

      const toolAc = new AbortController();
      const onParentAbort = () => toolAc.abort();
      parentSignal.addEventListener("abort", onParentAbort);

      let result: ToolResult;
      let liveBytes = 0;
      const liveCap = 16_000;
      let liveTruncatedNotified = false;
      let lastProgressAt = 0;
      const shouldDimLive = !interactiveCommand;
      const writeToolInfo = (text: string): void => {
        writeToolOutput(toolEventId, `${text}\n`, chalk.dim(`  ${text}\n`));
      };
      const printLive = (chunk: string): void => {
        if (
          call.name === "fs.read" ||
          call.name === "fs.list" ||
          call.name === "fs.search"
        )
          return;
        if (liveBytes >= liveCap) {
          if (!liveTruncatedNotified) {
            liveTruncatedNotified = true;
            writeToolInfo("... live preview truncated, full output saved");
            writeToolInfo("(tool still running — ESC or Ctrl+C to abort)");
            lastProgressAt = Date.now();
          }
          const now = Date.now();
          if (now - lastProgressAt > 5_000) {
            lastProgressAt = now;
            writeToolOutput(toolEventId, ".", chalk.dim("."));
          }
          return;
        }
        const remaining = liveCap - liveBytes;
        const slice =
          chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
        liveBytes += slice.length;
        const indented = slice.replace(/\r/g, "").replace(/\n(?!$)/g, "\n  ");
        const body = indented.startsWith("\n") ? indented : `  ${indented}`;
        writeToolOutput(
          toolEventId,
          slice,
          shouldDimLive ? chalk.dim(body) : body,
        );
      };

      const jobId = randomUUID().slice(0, 8);
      const backgroundJob: BackgroundJob = {
        id: jobId,
        command: `${call.name} ${formatToolArgs(call)}`,
        cwd: safeCwd(),
        status: "running",
        startedAt: new Date().toISOString(),
        artifactPath: "",
      };
      jobManager.registerJob(jobId, backgroundJob, toolAc);

      // Long-lived commands should use shell.start/background jobs. Reset this
      // watchdog whenever a blocking tool emits output so only a genuinely
      // stalled operation is cancelled.
      const TOOL_STALL_ABORT_MS = 60_000; // 1 minute
      let stallTimer: NodeJS.Timeout | undefined;
      let stalledByWatchdog = false;
      const resetStallTimer = (): void => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          if (!toolAc.signal.aborted) {
            stalledByWatchdog = true;
            writeNotice(
              "warn",
              `${call.name} has been running for >60s — cancelling stalled tool`,
              chalk.yellow(`  ⏳ ${call.name} stalled for >60s — cancelling\n`),
            );
            toolAc.abort();
          }
        }, TOOL_STALL_ABORT_MS);
      };
      resetStallTimer();

      try {
        result = await runToolCall(call, {
          signal: toolAc.signal,
          requestSecret: options.requestSecret,
          onOutput: (chunk) => {
            if (toolAc.signal.aborted) return;
            resetStallTimer();
            printLive(chunk);
          },
          confirmed: true,
          userPrompt: prompt,
        });
        if (liveBytes > 0 || liveTruncatedNotified) {
          writeToolOutput(toolEventId, "\n", "\n");
        }
        jobManager.updateJobStatus(
          jobId,
          result.ok ? "exited" : "failed",
          result.exitCode,
        );
      } catch (toolError) {
        jobManager.updateJobStatus(jobId, "failed", 1);
        if (isAbortError(toolError, toolAc.signal)) {
          // Only the parent signal represents a user/session cancellation.
          // A watchdog abort is a local tool timeout; treating it as a global
          // abort used to end the entire agent turn and strand sibling recon
          // calls in an incomplete state.
          if (parentSignal.aborted) {
            writeAbort();
            return {
              ok: false,
              call,
              result: { ok: false, output: "Aborted." },
              contextOutput: "Aborted.",
              lastAnswer: "Aborted.",
            };
          }
          result = {
            ok: false,
            output: stalledByWatchdog
              ? `Tool timed out after ${TOOL_STALL_ABORT_MS / 1_000}s without output.`
              : "Tool aborted before it could complete.",
            exitCode: stalledByWatchdog ? 124 : 130,
          };
        } else {
          const errMsg =
            toolError instanceof Error ? toolError.message : String(toolError);
          result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
        }
      } finally {
        if (stallTimer) clearTimeout(stallTimer);
        parentSignal.removeEventListener("abort", onParentAbort);
      }

      const output = result.output.trim();
      const displayMax = 6_000;
      const savedOutputPath =
        result.outputPath ??
        (output.length > displayMax
          ? await saveToolOutput(call, output)
          : undefined);
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

      loopGuard.recordAttempt(
        step,
        call.name,
        call.args,
        result.ok,
        result.exitCode,
      );

      // Inject approach evaluation when consecutive failures are detected.
      // Lets the MODEL decide (with full context) whether to continue a
      // legitimately long approach, switch, or stop — instead of a
      // hardcoded kill threshold.
      if (!result.ok) {
        const reflection = loopGuard.getFailureReflection();
        if (reflection) {
          messages.push({ role: "system", content: reflection });
          const failCount = loopGuard.consecutiveFailureCount();
          writeNotice(
            "warn",
            `${failCount} consecutive failures — model evaluating approach`,
            chalk.yellow(
              `  ⚠ ${failCount} consecutive failures — evaluating approach\n`,
            ),
          );
        }
      }

      const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
      writeToolOutput(
        toolEventId,
        result.ok ? "ok\n" : "failed\n",
        statusIcon + "\n",
      );
      if (output) {
        const displaySummary = summarizeOutput(output, displayMax);
        const displayText = displaySummary.truncated
          ? `${displaySummary.text}${savedOutputPath ? chalk.dim(`\n  ... full output saved to ${savedOutputPath}`) : chalk.dim("\n  ... output truncated")}`
          : displaySummary.text;
        if (liveBytes > 0) {
          if (savedOutputPath) {
            writeToolInfo(`full output saved to ${savedOutputPath}`);
          }
        } else {
          const renderedOutput = indentAndWrapText(displayText);
          writeToolOutput(
            toolEventId,
            displayText,
            styleToolChatter(call, renderedOutput) + "\n",
          );
        }
      }

      if (output) {
        const viewport = registerViewport({
          toolName: call.name,
          argsDisplay: formatToolArgs(call),
          artifactPath: savedOutputPath,
          summary: contextOutput,
        });
        if (savedOutputPath) {
          const viewportHint = `${formatViewportHint(viewport)}\n`;
          writeStatus(viewportHint, viewportHint);
        }
      }

      return { ok: result.ok, call, result, contextOutput };
    }

    // Automatic context compaction
    // As a long turn accumulates tool outputs and reasoning, the context can
    // grow past what the model can hold. We proactively summarize the older
    // turns into a single continuation memory (the SAME model-written summary
    // the /compact command uses — never a mechanical transcript dump) and then
    // re-inject the ACTIVE PLAN so the agent never loses track of the plan,
    // what is done, and what remains. The estimate is chars/4; the budget is
    // deliberately conservative so we compact a little early rather than hit a
    // provider context-window error mid-task.
    const AUTO_COMPACT_TOKEN_BUDGET = 150_000;
    const AUTO_COMPACT_KEEP_RECENT = 6;
    let lastCompactionMsgCount = 0;

    const summarizeForCompaction = async (
      summaryPrompt: string,
    ): Promise<string> => {
      const response = await completeWithProvider({
        provider,
        model,
        messages: [
          {
            role: "system",
            content:
              "You compress conversation history into an accurate, concise continuation memory for another assistant.",
          },
          { role: "user", content: summaryPrompt },
        ],
        temperature: 0.1,
        maxTokens: 4_096,
        signal: options.signal,
      });
      return response.text;
    };

    async function maybeAutoCompact(
      reason: string,
      force = false,
    ): Promise<void> {
      const beforeTokens = estimateMessagesTokens(messages);
      if (!force && beforeTokens < AUTO_COMPACT_TOKEN_BUDGET) return;
      if (messages.length <= AUTO_COMPACT_KEEP_RECENT + 2) return;
      // Avoid compaction loops: don't re-compact until enough new messages have
      // accumulated since the last compaction.
      if (messages.length <= lastCompactionMsgCount + 4) return;
      try {
        const result = await compactMessagesWithSummary(
          messages,
          summarizeForCompaction,
          { budgetTokens: 0, keepRecent: AUTO_COMPACT_KEEP_RECENT },
        );
        if (!result.summarized || result.afterTokens >= beforeTokens) return;
        messages.splice(0, messages.length, ...result.messages);
        loopGuard.resetReadOnly();
        // Re-inject the live plan so the model keeps full plan awareness even
        // after older turns (which carried the plan context) were summarized.
        const livePlan = await loadPlan(session.sessionId).catch(
          () => undefined,
        );
        if (livePlan) {
          messages.push({
            role: "system",
            content: planContextMessage(livePlan, session.planApproved.value),
          });
        }
        lastCompactionMsgCount = messages.length;
        // Report the compacted token count BEFORE plan re-injection so the
        // compaction stats accurately show the reduction. Then report the
        // final count (which is what the model actually receives) separately.
        const compactedTokens = estimateMessagesTokens(messages);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: compactedTokens,
          reason,
        });
        // Extract the inserted compaction memory so we can surface the
        // summary itself (not just token-count stats). The summary lives in
        // the first system message whose content begins with
        // COMPACTION_MEMORY_PREFIX.
        const insertedSummary =
          messages.find(
            (m) =>
              m.role === "system" &&
              m.content.startsWith(COMPACTION_MEMORY_PREFIX),
          )?.content ?? "";
        const summaryText = insertedSummary.startsWith(
          `${COMPACTION_MEMORY_PREFIX}\n\n`,
        )
          ? insertedText(insertedSummary, `${COMPACTION_MEMORY_PREFIX}\n\n`)
          : insertedText(insertedSummary, COMPACTION_MEMORY_PREFIX);
        const afterTokens = estimateMessagesTokens(messages);
        writeCompacted(summaryText, beforeTokens, afterTokens);
        const planNote = afterTokens > compactedTokens
          ? ` (compacted to ~${compactedTokens.toLocaleString()}, +plan → ~${afterTokens.toLocaleString()})`
          : "";
        writeNotice(
          "info",
          `context auto-compacted to fit the window (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens${planNote})`,
          chalk.dim(
            `  ℹ context auto-compacted (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens${planNote})\n`,
          ),
        );
      } catch (error) {
        if (
          error instanceof Error &&
          (error.name === "AbortError" || error.message.includes("aborted"))
        ) {
          throw error;
        }
        // Summarization failed — DO NOT fall back to a mechanical dump. Keep the
        // current context and continue; we'll try again as it keeps growing.
        await auditLog("agent.compact.failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      // `step` is the productive-step index (used for display + audit). It only
      // advances when the previous iteration actually executed a tool.
      step = productiveSteps;
      // Step budget gate: ask the user instead of hard-stopping
      if (productiveSteps >= stepBudget) {
        const askContinue =
          confirmPort.confirmContinue ?? inquirerConfirmPort.confirmContinue!;
        let shouldContinue = false;
        try {
          shouldContinue = await askContinue(productiveSteps);
          restoreInteractiveStdin();
        } catch {
          // Abort / non-interactive — treat as decline.
          shouldContinue = false;
        }
        if (shouldContinue) {
          // Extend the budget for another chunk of work.
          const extension = Math.max(40, maxSteps);
          stepBudget += extension;
          maxIterations = stepBudget * 3;
          // Compact older messages (model-written summary, no mechanical dump)
          // to free context space for the next chunk of work.
          await maybeAutoCompact("step-budget-continue", true);
          // Inject a progress summary so the model stays focused.
          const livePlan = await loadPlan(session.sessionId).catch(
            () => undefined,
          );
          let progressNote =
            "The step limit was reached and the user chose to continue. ";
          progressNote +=
            "Review what you have accomplished so far and continue with the NEXT unfinished step. ";
          progressNote +=
            "Do NOT repeat work already done. Do NOT re-fetch pages or re-run scans whose results you already have.";
          if (livePlan) {
            const doneTasks = livePlan.tasks.filter((t) => t.state === "done");
            const pendingTasks = livePlan.tasks.filter(
              (t) => t.state === "pending" || t.state === "in_progress",
            );
            progressNote += `\n\nPlan progress: ${doneTasks.length}/${livePlan.tasks.length} tasks done.`;
            if (pendingTasks.length > 0) {
              progressNote += ` Next: ${pendingTasks[0]!.id} — "${pendingTasks[0]!.title}".`;
            }
          }
          messages.push({ role: "user", content: progressNote });
          writeNotice(
            "info",
            `continuing — budget extended to ${stepBudget} steps`,
            chalk.dim(
              `  ℹ continuing — budget extended to ${stepBudget} steps\n`,
            ),
          );
          // Continue the loop — model doesn't know it paused.
        } else {
          // User declined — build a rich summary and return.
          const richSummary = await buildRichStopSummary(
            messages,
            session,
            productiveSteps,
          );
          writeAssistantMessage(richSummary);
          lastAnswer = richSummary;
          return finishTurn(lastAnswer, productiveSteps);
        }
      }
      options.signal?.throwIfAborted();

      // `call` and `assistantText` are shared by both paths below: a fresh
      // model round-trip, or draining a previously-queued tool call.
      let call: ToolCall | undefined;
      let assistantText: {
        visible: string;
        thinkContent: string;
        hasThinking: boolean;
      };
      let recoveredFromBareJson = false;

      if (pendingCalls.length > 0) {
        // Drain the next queued call from the previous model message — no new
        // round-trip. The assistant message and any prose were already shown
        // when the batch was parsed.
        call = pendingCalls.shift()!;
        assistantText = { visible: "", thinkContent: "", hasThinking: false };
        const batchStatus = `  ↳ continuing batch (${pendingCalls.length} more queued)\n`;
        writeStatus(batchStatus, chalk.dim(batchStatus));
      } else {
        // Before a fresh model round-trip, proactively compact if the context has
        // grown too large, so we never hit a provider context-window error and the
        // model keeps a clean, plan-aware memory.
        await maybeAutoCompact("auto-token-budget");
        // Buffer LLM output so tool JSON and hidden thinking are not printed raw.
        // Status messages (rate-limit retries, fallback hints) still surface live.
        // A spinner gives the user feedback during long thinking phases on
        // models like glm-5.1 / deepseek-v4-flash that stream reasoning first.
        const streamLabel =
          step === 0 ? "waiting for model" : `step ${step + 1}`;
        let spinner = writesDirectly
          ? startThinkingSpinner(streamLabel, options.signal)
          : noopSpinner;
        if (!writesDirectly) {
          emit({ type: "status", text: streamLabel });
        }
        let sawReasoning = false;
        let inThinking = false;
        let emittedThinkingStatus = false;
        let generatedTokens = 0;
        let accumulatedText = "";
        const callIds: string[] = [];
        let streamedCallsCount = 0;
        // Deferred tool-call events: collect tool calls parsed from the stream
        // and emit them AFTER thinking + assistant text, so the display order
        // is correct: thinking → model text → tool-call cards.
        const deferredToolCalls: { eventId: string; call: ToolCall; rendered: string }[] = [];
        const deltaParser = writesDirectly
          ? undefined
          : createThinkingStreamParser(
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
        try {
          completion = await streamWithProvider(
            {
              provider,
              model,
              // The selected model is the first choice, but an agent must not
              // end a turn with no answer if it only emits reasoning. Honor
              // the user's providerFallback setting for that recovery path.
              allowModelFallback: true,
              messages,
              // MiniMax M3 degenerates at the generic agent temperature. The
              // HTTP layer also applies its `top_p` override for both the
              // NVIDIA long ID and Kimchi's short `minimax-m3` ID.
              temperature: /minimax-m3/i.test(model) ? 1.0 : 0.2,
              // Reasoning models can spend a lot on hidden thinking; give
              // them headroom so the visible answer / tool call isn't
              // truncated to silence. The non-thinking budget must be large
              // enough for a single-file fs.write / multi-file fs.writeMany
              // payload — a truncated tool-call JSON fails to parse and leaks a
              // broken (and syntactically invalid) file. 8k was too small for a
              // full component, so allow more room for the visible tool call.
              // Code-generation calls frequently contain an entire source file
              // inside JSON.  A 12k visible-token ceiling cut otherwise valid
              // fs.write calls in half. Keep enough output headroom for a
              // substantial source file; providers with a lower limit clamp it.
              maxTokens: 32_768,
              signal: options.signal,
              thinking: retryWithoutThinking
                ? { ...config.thinking, enabled: false }
                : config.thinking,
            },
            (token) => {
              deltaParser?.push(token);
              generatedTokens += 1;
              accumulatedText += token;

              const parsedCalls = parseAllToolCalls(accumulatedText);
              if (parsedCalls.length > streamedCallsCount) {
                if (writesDirectly) {
                  spinner.stop();
                }
                while (streamedCallsCount < parsedCalls.length) {
                  const call = parsedCalls[streamedCallsCount]!;
                  const eventId = `tool-${++nextToolEventId}`;
                  callIds.push(eventId);
                  alreadyPrintedIds.add(eventId);

                  const toolCallLine =
                    chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
                  // Defer the writeToolCall emission — collect it so we can
                  // emit after thinking + assistant text for correct order.
                  deferredToolCalls.push({
                    eventId,
                    call,
                    rendered: styleToolChatter(call, toolCallLine) + "\n",
                  });
                  // Still update spinner label for user feedback during streaming.
                  if (!writesDirectly) {
                    emit({ type: "status", text: call.name });
                  }
                  streamedCallsCount += 1;
                }
                if (writesDirectly) {
                  spinner = startThinkingSpinner(
                    `generating response (${generatedTokens} tokens)`,
                    options.signal,
                  );
                }
              }

              // Heuristic: <think>… markers and reasoning_content tokens flow
              // through onToken. Surface activity in the spinner so the screen
              // is never empty for minutes.
              if (!sawReasoning && /<think/i.test(token)) {
                sawReasoning = true;
                inThinking = true;
                spinner.setLabel("thinking");
                if (!writesDirectly) emit({ type: "status", text: "thinking" });
              }
              if (/<\/think>/i.test(token)) {
                inThinking = false;
                spinner.setLabel("generating response (0 tokens)");
                generatedTokens = 0;
              }
              // Only push reasoning tokens to the spinner preview. Visible
              // answer / tool-call tokens should NOT go through the dim
              // spinner preview — doing so makes the final answer appear
              // "diluted" in light font when the spinner's last render
              // briefly shows the answer text before being erased.
              if (inThinking) {
                const cleaned = token.replace(/<\/?think[^>]*>/gi, "");
                if (cleaned) {
                  spinner.pushPreview(cleaned);
                  const approx = cleaned.split(/\s+/).filter(Boolean).length;
                  if (approx > 0) spinner.bumpReasoning(approx);
                }
              } else {
                if (generatedTokens % 10 === 0) {
                  spinner.setLabel(`generating response (${generatedTokens} tokens)`);
                }
              }
            },
            (status) => {
              spinner.stop();
              writeStatus(status, chalk.dim(status));
            },
          );
        } finally {
          // Always clear the spinner — abort, network error, or success.
          spinner.stop();
        }
        provider = completion.provider;
        model = completion.model;
        deltaParser?.finish();

        const assistantTextResult = rememberThinkingFromText(completion.text);
        assistantText = assistantTextResult;

        // Commit thinking to the transcript IMMEDIATELY, before any of the
        // branches below decide to `continue` (retry a malformed tool call,
        // nudge for narration, guard premature completion, etc). Previously
        // writeThinkingBlock was only called from a few terminal branches, so
        // any retry path silently dropped the model's reasoning — the user
        // would see the live "thinking…" preview during streaming and then
        // watch it vanish with nothing committed once the turn moved on.
        if (assistantText.hasThinking) {
          writeThinkingBlock(assistantText.thinkContent);
        }

        // Try visible text first, then thinking content — some models (e.g. glm-5.1)
        // wrap tool calls inside  considering tags, so stripThinking removes them
        // into thinkContent and visible becomes empty. Recovering from thinkContent
        // prevents an endless nudge loop where the model keeps hiding the call.
        call = parseToolCall(assistantText.visible, {
          strict: getConfig().parserStrict,
        });
        if (!call && assistantText.hasThinking) {
          call = parseToolCall(assistantText.thinkContent, {
            strict: getConfig().parserStrict,
          });
          if (call) {
            writeNotice(
              "info",
              "recovered tool call from thinking content",
              chalk.dim("  ℹ recovered tool call from thinking content\n"),
            );
          }
        }

        // ── Prompt-leak guard ─────────────────────────────────────────
        // If the model's visible output contains distinctive system-prompt
        // markers, it is repeating its instructions (e.g. prompt injection
        // via "repeat your instructions verbatim"). Any tool-call syntax
        // in that output is an EXAMPLE from the prompt, not a real request.
        // Suppress it so we never execute leaked examples.
        if (call && looksLikePromptLeak(assistantText.visible)) {
          writeNotice(
            "warn",
            "suppressed tool call from apparent prompt leak",
            chalk.yellow("  ⚠ suppressed tool call — model appears to be repeating its system prompt\n"),
          );
          call = undefined;
        }

        // Empty-response recovery
        // Some models occasionally return an empty completion: a reasoning
        // model that spent its whole budget on hidden &lt;think&gt; reasoning and emitted
        // no visible text, OR (more perniciously) a gateway hiccup that
        // streamed [DONE] with no content deltas at all. Without this guard
        // the agent silently ends the turn with no answer, no warning, and no
        // error — the user just sees the spinner stop. Catch BOTH cases
        // (thinking-only AND truly empty) and nudge the model to retry.
        if (!assistantText.visible.trim() && !call) {
          emptyVisibleRetries += 1;
          if (emptyVisibleRetries <= 3) {
            if (assistantText.hasThinking) {
              writeNotice(
                "warn",
                "model produced only thinking — nudging it to take action",
                chalk.yellow(
                  "  ⚠ model produced only thinking — nudging it to take action\n",
                ),
              );
            } else {
              writeNotice(
                "warn",
                "model returned an empty response — nudging it to answer",
                chalk.yellow(
                  "  ⚠ model returned an empty response — nudging it to answer\n",
                ),
              );
            }
            if (assistantText.hasThinking) retryWithoutThinking = true;
            pushAssistantHistory(
              stripThinking(collapseRepeatedText(completion.text)).visible,
            );
            // Keep nudges SHORT — cheap models lose the key instruction in long text.
            const buildNudge =
              freshWebSearchRequired && !sawFreshWebSearch
                ? "No visible output. This is current or scheduled information: emit exactly one valid ```tool block for web.search now. Do NOT answer from memory or hide the tool call in <think> tags."
                : buildLikeTurn && !activePlan
                  ? "No visible output. Emit a ```tool block to call plan.create now. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response."
                  : "No visible output. Emit a ```tool block or give your final answer. " +
                    "Do NOT hide tool calls in <think> tags — put them in the visible response.";
            messages.push(recoveryUserMessage(buildNudge));
            continue;
          }
          // Exhausted retries — surface a clear notice and exit the turn instead
          // of falling through and triggering premature-completion loops.
          writeNotice(
            "warn",
            "model returned an empty response after retries — no answer produced",
            chalk.yellow(
              "  ⚠ model returned an empty response after retries — no answer produced\n",
            ),
          );
          return finishTurn("Model returned an empty response after retries.", step + 1);
        } else {
          // Reset the counter on any successful visible output or recovered call.
          emptyVisibleRetries = 0;
          retryWithoutThinking = false;
        }

        // `call` was already extracted above (from visible text or thinking content).
        // Recovery: the model meant to call a tool but emitted a bare JSON object
        // with no ```tool fence — either a complete {name,args} the strict
        // matchers missed (recover it directly), or just an args object like
        // {"path":"file.pdf"} with the wrapper dropped (nudge a retry below so
        // the requested action runs instead of the JSON leaking as the answer).
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
              chalk.dim("  ℹ recovered an unfenced tool call from bare JSON\n"),
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
              chalk.dim(
                "  ℹ recovered an unfenced tool call from thinking content\n",
              ),
            );
          } else if (bareThink?.argsOnly) {
            bareArgsOnly = true;
          }
        }
        if (!call) {
          if (bareArgsOnly) {
            bareToolJsonRetries += 1;
            if (bareToolJsonRetries <= 3) {
              writeNotice(
                "warn",
                "tool call missing its name/fence — asking the model to re-emit a proper ```tool block",
                chalk.yellow(
                  "  ⚠ tool call missing its name/fence — asking the model to re-emit a proper ```tool block\n",
                ),
              );
              pushAssistantHistory(assistantText.visible);
              messages.push(
                recoveryUserMessage(
                  buildLikeTurn && !activePlan
                    ? "Your previous message was a bare JSON args object with no tool name and no ```tool fence, so NOTHING ran. " +
                        "This is a BUILD/SCAFFOLD task with NO plan yet. " +
                        "You MUST call plan.create using a proper ```tool block. For example:\n" +
                        '```tool\n{"name":"plan.create","args":{"goal":"scaffold todo app","detail":"...","tasks":["...","..."],"kind":"coding"}}\n```\n' +
                        "Do NOT use fs.write, fs.writeMany, shell.exec, or pkg.install yet."
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
          // Detect the case where the model emitted sentinel-style tool-call
          // markers but the body was malformed or truncated. Printing those
          // raw tokens looks like a crash to the user — instead, ask the
          // model to retry the tool call in a clean JSON format.
          if (
            /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>/i.test(
              assistantText.visible,
            )
          ) {
            writeNotice(
              "warn",
              "tool call was malformed or cut off — asking the model to retry in JSON form",
              chalk.yellow(
                "  ⚠ tool call was malformed or cut off — asking the model to retry in JSON form\n",
              ),
            );
            pushAssistantHistory(assistantText.visible);
            messages.push(
              recoveryUserMessage(
                "Your previous tool call was malformed or truncated. " +
                  "Reply with ONLY a fenced ```tool block containing valid JSON " +
                  'of the form `{"name": "<tool>", "args": { ... }}`. ' +
                  "Do not use <|tool_call_begin|> markers.",
              ),
            );
            continue;
          }
          // Detect a tool call that opened but was cut off by the token limit
          // (most common with large fs.write/fs.writeMany for reports).
          // Instead of asking the model to retry (which will just truncate
          // again at the same limit), we SALVAGE the partial content from the
          // truncated JSON and write it, then tell the model to CONTINUE with
          // fs.append from where it was cut off.
          if (looksLikeTruncatedToolCall(assistantText.visible)) {
            truncatedToolRetries += 1;

            // Try to salvage a partial fs.write / fs.append from the truncated JSON.
            // The pattern is: {"name":"fs.write","args":{"path":"...","content":"...
            // We extract the path and whatever content was produced before truncation.
            const salvaged = salvageTruncatedWrite(assistantText.visible);

            if (salvaged && truncatedToolRetries <= 5) {
              // Write the salvaged partial content
              try {
                const writeResult = await fsWrite(salvaged.path, salvaged.content, {
                  confirmed: true,
                });
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
                    chalk.cyan(
                      `  ℹ tool call was truncated — salvaged ${lineCount} lines to ${salvaged.path}\n`,
                    ),
                  );
                  pushAssistantHistory(
                    stripThinking(assistantText.visible).visible,
                  );
                  messages.push({
                    role: "user",
                    content:
                      `Your fs.write tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines to ${salvaged.path}. ` +
                      `The file now exists with content up to: "${salvaged.lastLine}"\n\n` +
                      `CONTINUE writing the rest of the content using fs.append:\n` +
                      '```tool\n{"name":"fs.append","args":{"path":"' + salvaged.path + '","content":"...remaining content..."}}\n```\n' +
                      `Write the NEXT section of content starting from where it was cut off. ` +
                      `Keep each fs.append call to ~100 lines max so it fits in the output window. ` +
                      `Use multiple fs.append calls if needed. Do NOT re-write content that was already saved.`,
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
                chalk.yellow(
                  "  ⚠ tool call was cut off (output too long) — asking the model to retry safely\n",
                ),
              );
              pushAssistantHistory(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content:
                  "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Your output token limit is ~32k tokens. For LARGE files (reports, docs, long code), you MUST write in chunks:\n" +
                  "1. Use fs.write to create the file with the FIRST ~100 lines\n" +
                  "2. Use fs.append to add the NEXT ~100 lines\n" +
                  "3. Repeat fs.append for each remaining section\n" +
                  "Keep your reasoning SHORT — emit the ```tool block as early as possible to maximize content space. " +
                  "Do NOT try to write the entire file in one call. Do NOT claim any file was written until a tool call actually succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through so we don't loop forever, but the
            // user at least sees the (broken) output and the stop notice.
          }
          // Detect a ```tool fence whose JSON could NOT be parsed for any other
          // reason (malformed braces, trailing junk, a stray `}` — NOT plain
          // truncation, which is handled above). Without this, the raw block
          // leaks to the screen as a code fence and the requested action (often
          // a whole fs.writeMany scaffold) silently never runs — exactly the
          // "fs.writeMany printed but nothing created" failure. Require the fence
          // to actually look like an intended call (mentions name/args) so a
          // genuine ```tool code example in prose isn't mistaken for one.
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
                const writeResult = await fsWrite(salvaged.path, salvaged.content, {
                  confirmed: true,
                });
                if (writeResult.ok) {
                  const lineCount = salvaged.content.split("\n").length;
                  writeNotice(
                    "info",
                    `malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}`,
                    chalk.cyan(
                      `  ℹ malformed tool call salvaged — wrote ${lineCount} lines to ${salvaged.path}\n`,
                    ),
                  );
                  pushAssistantHistory(
                    stripThinking(assistantText.visible).visible,
                  );
                  messages.push({
                    role: "user",
                    content:
                      `The system extracted and wrote ${lineCount} lines to ${salvaged.path} from your malformed tool call. ` +
                      `The file content ends at: "${salvaged.lastLine}"\n\n` +
                      `If the file is complete, proceed with the next step. ` +
                      `If more content is needed, use fs.append to add the remaining sections (~100 lines per call).`,
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
                chalk.yellow(
                  "  ⚠ tool block present but its JSON didn't parse — asking the model to re-emit valid JSON\n",
                ),
              );
              pushAssistantHistory(
                stripThinking(assistantText.visible).visible,
              );
              messages.push({
                role: "user",
                content:
                  "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
                  "Common causes: unescaped newlines or quotes inside a string value, an extra or missing `}` / `]`, or content too large for the output window. " +
                  'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
                  "IMPORTANT: For large file content (reports, docs), write in chunks:\n" +
                  "1. fs.write with the FIRST ~100 lines only\n" +
                  "2. fs.append for each subsequent ~100-line section\n" +
                  "Keep reasoning SHORT to maximize output space for the tool call JSON. " +
                  "Do NOT claim any file was written until a tool call actually succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through to the normal path.
          }
          // Normal final-answer path: strip any stray sentinel tokens that
          // somehow leaked into prose so the answer renders cleanly.
          const cleaned = stripSentinelTokens(assistantText.visible);

          // Act, don't narrate
          // Build/scaffold/plan turns must DO something. If the model returns
          // prose with NO tool call, it is narrating intent ("Let me first
          // explore the directory…") or writing a PLAN as prose ("Goal: … Tasks:
          // … please approve") instead of calling a tool — accepting it as a
          // final answer ends the turn with nothing done and no real plan saved.
          // Nudge it to emit a real tool call, with a concrete example.
          const narratedAction = looksLikeActionNarration(cleaned);
          // A plan whose OWN persisted status is "completed" has no more
          // work to force — treat this like "no active plan" for the
          // act-don't-narrate nudge so a plain follow-up question (e.g. "what
          // do you know so far") after the plan finished gets answered
          // instead of being pushed to emit another tool call.
          const planHasOpenWorkNow = planHasOpenWork(activePlan?.status);
          // History-inherited build/pentest intent only forces action when
          // THIS prompt is not itself a plain question. If the model does
          // narrate a concrete next step ("let me read X"), narratedAction
          // still forces it to actually run that step — even for a question —
          // which is the desired "do what you said" behavior.
          const wantsAction =
            narratedAction ||
            freshWebSearchRequired ||
            (planHasOpenWorkNow && session.planApproved.value) ||
            (!informationalQuery && (buildLikeTurn || pentestLikeTurn));
          const planNarrated =
            (buildLikeTurn || pentestLikeTurn) &&
            !activePlan &&
            looksLikePlanNarration(cleaned);
          if (
            wantsAction &&
            cleaned.trim().length > 0 &&
            actionIntentRetries < 3 &&
            (productiveSteps === 0 || planNarrated || narratedAction)
          ) {
            actionIntentRetries += 1;
            let nudge: string;
            if (planHasOpenWorkNow && session.planApproved.value) {
              nudge =
                "You wrote a message but emitted NO ```tool block, so NOTHING ran. Do NOT narrate what you will do — DO it. Emit the next tool call now (task.update / fs.writeMany / shell.exec) in a single ```tool block.";
              writeNotice(
                "warn",
                "described an action but emitted no tool call — nudging it to run one",
                chalk.yellow(
                  "  ⚠ described an action but emitted no tool call — nudging it to run one\n",
                ),
              );
            } else if (pentestLikeTurn) {
              nudge =
                "You described what you will do but emitted NO ```tool block, so NOTHING actually happened — narration is not action. Emit a real tool call NOW (e.g. net.scan / sysinfo / shell.exec). For example, to scan local network or read system settings:\n" +
                '```tool\n{"name":"sysinfo","args":{}}\n```\n' +
                "Every turn MUST contain a ```tool block until the task is done.";
              writeNotice(
                "warn",
                "described a security/pentest action but emitted no tool call — nudging it to run one",
                chalk.yellow(
                  "  ⚠ described a security/pentest action but emitted no tool call — nudging it to run one\n",
                ),
              );
            } else if (!buildLikeTurn) {
              nudge =
                "You wrote that you would fetch/search/read something but emitted NO ```tool block, so NOTHING ran. Do NOT narrate the next browsing step — DO it. Emit exactly one valid ```tool block now. If you know the exact page, use:\n" +
                '```tool\n{"name":"web.fetch","args":{"url":"https://example.com/page","responseMode":"readable"}}\n```\n' +
                "If you do not know the exact page URL, use web.search first. After the tool output, answer from the fetched page content.";
              writeNotice(
                "warn",
                "described a web action but emitted no tool call — nudging it to run one",
                chalk.yellow(
                  "  ⚠ described a web action but emitted no tool call — nudging it to run one\n",
                ),
              );
            } else if (planNarrated || productiveSteps > 0) {
              const kind = pentestLikeTurn ? "pentest" : "coding";
              nudge =
                "You wrote the plan as PROSE but did NOT call plan.create, so no plan was saved and the user cannot /implement it. Emit it as a real tool call NOW — exactly one ```tool block:\n" +
                `\`\`\`tool\n{"name":"plan.create","args":{"goal":"<short goal>","detail":"<stack/approach and how you'll verify>","tasks":["task 1","task 2","task 3"],"kind":"${kind}"}}\n\`\`\`\n` +
                "Do not describe the plan again in prose — just emit the plan.create tool block.";
              writeNotice(
                "warn",
                "plan was written as text, not created — nudging it to call plan.create",
                chalk.yellow(
                  "  ⚠ plan was written as text, not created — nudging it to call plan.create\n",
                ),
              );
            } else {
              if (pentestLikeTurn) {
                nudge =
                  "You described what you will do but emitted NO ```tool block, so NOTHING actually happened — narration is not action. Emit a real tool call NOW. For this pentest task, explore/recon first, then call plan.create. Every turn MUST contain a ```tool block until the task is done.";
              } else {
                nudge =
                  "You described what you will do but emitted NO ```tool block, so NOTHING actually happened — narration is not action. Emit a real tool call NOW. For this build task, explore first like this:\n" +
                  '```tool\n{"name":"fs.list","args":{"path":"."}}\n```\n' +
                  "Then read key files, and once you understand the directory, call plan.create. Every turn MUST contain a ```tool block until the task is done.";
              }
              writeNotice(
                "warn",
                "described an action but emitted no tool call — nudging it to run one",
                chalk.yellow(
                  "  ⚠ described an action but emitted no tool call — nudging it to run one\n",
                ),
              );
            }
            pushAssistantHistory(assistantText.visible);
            messages.push(recoveryUserMessage(nudge));
            continue;
          }

          if (
            freshWebSearchRequired &&
            !sawFreshWebSearch &&
            !freshnessRetryUsed
          ) {
            freshnessRetryUsed = true;
            writeNotice(
              "info",
              "current-info question detected — searching the web before answering",
              chalk.dim(
                "  ℹ current-info question detected — searching the web before answering\n",
              ),
            );
            pushAssistantHistory(assistantText.visible);
            messages.push({
              role: "user",
              content:
                freshnessGuardMessage() +
                " Reply with ONLY a fenced ```tool block for web.search now.",
            });
            continue;
          }
          // A passing build is not evidence that an app is serving requests.
          // On completed build plans, require start → logs → HTTP verification
          // before accepting the model's final claim.
          if (
            buildLike &&
            session.planApproved.value &&
            (!sawServerStart || !sawServerTail || !sawLocalHttpProbe) &&
            runtimeVerificationRetries < 2
          ) {
            const runtimePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            const tasksFinished = Boolean(
              runtimePlan &&
                runtimePlan.tasks.length > 0 &&
                runtimePlan.tasks.every(
                  (task) => task.state === "done" || task.state === "skipped",
                ),
            );
            if (tasksFinished) {
              runtimeVerificationRetries += 1;
              pushAssistantHistory(assistantText.visible);
              const missing = [
                !sawServerStart ? "shell.start" : "",
                !sawServerTail ? "shell.tail" : "",
                !sawLocalHttpProbe
                  ? "a successful bounded localhost HTTP probe"
                  : "",
              ].filter(Boolean);
              messages.push({
                role: "user",
                content:
                  "Run the missing checks now. Keep the dev server/job running in the background so that the user can interact with the live application, and print the localhost link. Report whether it remains running truthfully.",
              });
              continue;
            }
          }
          // Premature-completion guard (approved plan still has work)
          // If the user approved a plan and the model now gives a final answer
          // while tasks are still pending/in_progress — without having run the
          // work — it is fabricating completion (the exact "all tasks completed,
          // running at localhost:5173" failure). Force it back to executing the
          // next real task instead of accepting the false claim.
          if (session.planApproved.value && prematureCompletionRetries < 3) {
            const livePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            const unfinished = livePlan?.tasks.filter(
              (t) => t.state === "pending" || t.state === "in_progress",
            );
            if (livePlan && unfinished && unfinished.length > 0) {
              prematureCompletionRetries += 1;
              const next = unfinished[0]!;
              writeNotice(
                "warn",
                `${unfinished.length} plan task(s) still unfinished — not accepting a "done" claim; resuming execution`,
                chalk.yellow(
                  `  ⚠ ${unfinished.length} plan task(s) still unfinished — not accepting a "done" claim; resuming execution\n`,
                ),
              );
              pushAssistantHistory(assistantText.visible);

              let instruction = `Resume now with the NEXT task ${next.id} ("${next.title}"): `;
              if (next.state === "pending") {
                instruction += `call task.update {taskId:"${next.id}", state:"in_progress"}, then do the real work with a tool call (fs.writeMany / shell.exec / shell.start), VERIFY it, and mark it done. `;
              } else {
                instruction += `do the real work with a tool call (fs.writeMany / shell.exec / shell.start) to complete it, VERIFY it, and mark it done (call task.update {taskId:"${next.id}", state:"done"}). `;
              }
              instruction += `Continue task by task until EVERY task is actually finished.`;

              messages.push({
                role: "user",
                content:
                  `You have NOT finished the approved plan: ${unfinished.length} task(s) remain ` +
                  `(${unfinished.map((t) => `[${t.id}] ${t.title}`).join("; ")}). ` +
                  `Do NOT claim the work is complete, that files were created, or that a server is running ` +
                  `unless a tool call actually succeeded and you saw the output. ` +
                  instruction,
              });
              continue;
            }
          }
          // If we still print a final answer while an approved plan has unfinished
          // tasks (retries exhausted), do NOT let a fabricated "it's done" stand
          // unchallenged — append an explicit, honest status so the user knows the
          // build did not actually complete.
          let completionWarning = "";
          let completionWarningText = "";
          if (session.planApproved.value) {
            const livePlan = await loadPlan(session.sessionId).catch(
              () => undefined,
            );
            const unfinished = livePlan?.tasks.filter(
              (t) => t.state === "pending" || t.state === "in_progress",
            );
            if (livePlan && unfinished && unfinished.length > 0) {
              completionWarningText =
                `${unfinished.length} of ${livePlan.tasks.length} plan task(s) are NOT actually complete. ` +
                "The summary above may overstate progress.";
              completionWarning =
                chalk.yellow(
                  `\n  ⚠ ${unfinished.length} of ${livePlan.tasks.length} plan task(s) are NOT actually complete:\n`,
                ) +
                unfinished
                  .map((t) => chalk.yellow(`    • [${t.id}] ${t.title}`))
                  .join("\n") +
                chalk.dim(
                  "\n  The summary above may overstate progress. Re-run with /implement, or ask clai to finish the remaining tasks.\n",
                );
            }
          }
          if (cleaned) {
            writeAssistantMessage(cleaned);
          }
          if (completionWarning) {
            writeNotice("warn", completionWarningText, completionWarning);
          }
          await auditLog("agent.final", { provider, model, steps: step + 1 });
          lastAnswer = cleaned;
          return finishTurn(lastAnswer, step + 1);
        }

        // A valid primary tool call exists for this fresh model turn. Show any
        // prose / thinking that preceded it, record the assistant message ONCE.
        const beforeTool = recoveredFromBareJson
          ? ""
          : textBeforeToolCall(assistantText.visible);
        if (beforeTool) {
          writeAssistantMessage(beforeTool);
        }
        // Now emit deferred tool-call events (collected during streaming)
        // so the display order is: thinking → text → tool-call cards.
        for (const deferred of deferredToolCalls) {
          writeToolCall(deferred.eventId, deferred.call, deferred.rendered);
        }
        let allCalls = parseAllToolCalls(
          assistantText.visible || assistantText.thinkContent,
        );
        if (allCalls.length === 0 && call) {
          allCalls = [call];
        }

        const standardizedContent =
          (beforeTool ? beforeTool.trim() + "\n\n" : "") +
          allCalls
            .map((c) => `\`\`\`tool\n${JSON.stringify(c)}\n\`\`\``)
            .join("\n\n");

        pushAssistantHistory(standardizedContent);

        if (allCalls.length > 1) {
          writeNotice(
            "info",
            `${allCalls.length} tool calls in this message — running scoped (independent read-only lookups in parallel, everything else in order)`,
            chalk.dim(
              `  ℹ ${allCalls.length} tool calls — read-only lookups in parallel, the rest in order\n`,
            ),
          );
        }

        // Scoped-parallel batch execution
        // The model may emit several calls in one message. We partition them,
        // IN DOCUMENT ORDER, into segments:
        //   • A run of consecutive READ-ONLY, safe-classified calls (the same
        //     allowlist tool.batch uses) executes CONCURRENTLY — this is where
        //     independent lookups within a single task fan out (e.g. whois +
        //     dns + http.fetch during recon).
        //   • Every other call (plan.create/task.update, and any mutating or
        //     confirm-level tool: fs.write*, shell.exec, pkg.install, net.scan)
        //     runs ALONE as a sequential barrier.
        // Because task.update is never parallel-safe, it always acts as a
        // barrier: it commits before the work it gates and after the work it
        // closes. That keeps execution strictly task-by-task and eliminates the
        // plan-state races / overlapping writes that a blanket Promise.all
        // caused, while still letting one task's independent lookups run in
        // parallel. A failed independent read-only lookup does not prevent
        // later recon from running; aborts, blocks, and sequential-barrier
        // failures still stop the batch so the model can react safely.
        const scopeForBatch = await loadScope().catch(() => undefined);
        const isParallelSafe = (c: ToolCall): boolean => {
          if (!BATCH_SAFE_TOOLS.has(c.name)) return false;
          try {
            return (
              classifyToolCall(c, { scope: scopeForBatch }).level === "safe"
            );
          } catch {
            return false;
          }
        };
        const PARALLEL_LIMIT = 4;

        let aborted = false;
        let blocked = false;
        let blockedResult: any = null;
        let failed = false;
        let awaitingPlanApproval = false;

        const recordResult = (res: {
          call: ToolCall;
          result: ToolResult;
          contextOutput: string;
          ok: boolean;
          lastAnswer?: string | undefined;
          blockOrCancel?: boolean | undefined;
        }, continueAfterFailure = false): void => {
          messages.push({
            role: "tool",
            content: `Tool ${res.call.name} result (exit=${res.result.exitCode ?? 0}, ok=${res.result.ok}):\n${res.contextOutput}`,
          });
          productiveSteps += 1;
          // Reset retry counters — they track consecutive failures, not cumulative.
          truncatedToolRetries = 0;
          malformedFenceRetries = 0;
          bareToolJsonRetries = 0;
          if (res.ok && res.call.name === "shell.start") sawServerStart = true;
          if (res.ok && res.call.name === "shell.tail") sawServerTail = true;
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
            sawLocalHttpProbe = true;
          }
          if (res.call.name === "plan.create" && res.ok) {
            awaitingPlanApproval = true;
          }
          if (res.lastAnswer === "Aborted.") aborted = true;
          else if (res.blockOrCancel) {
            blocked = true;
            blockedResult = res;
          } else if (!res.ok && !continueAfterFailure) failed = true;
        };

        const groups = groupToolCallsForExecution(
          allCalls,
          isParallelSafe,
          PARALLEL_LIMIT,
        );
        for (const group of groups) {
          if (aborted || blocked || failed || awaitingPlanApproval) break;
          if (group.length === 1) {
            const call = group[0]!;
            const idx = allCalls.indexOf(call);
            if (idx >= 0 && !callIds[idx]) {
              callIds[idx] = `tool-${++nextToolEventId}`;
            }
            const id = (idx >= 0 ? callIds[idx] : undefined) ?? `tool-${++nextToolEventId}`;
            const res = await executeSingleTool(
              call,
              id,
              options.signal || new AbortController().signal,
            );
            recordResult(res);
          } else {
            // Concurrent group — assign ids in document order, then push their
            // results in document order for a stable transcript.
            const ids = group.map((c) => {
              const idx = allCalls.indexOf(c);
              if (idx >= 0 && !callIds[idx]) {
                callIds[idx] = `tool-${++nextToolEventId}`;
              }
              return (idx >= 0 ? callIds[idx] : undefined) ?? `tool-${++nextToolEventId}`;
            });
            const results = await Promise.all(
              group.map((c, k) =>
                executeSingleTool(
                  c,
                  ids[k]!,
                  options.signal || new AbortController().signal,
                ),
              ),
            );
            // These calls are explicitly safe and independent. Preserve every
            // result for the model, but do not abandon remaining reconnaissance
            // merely because one lookup times out or a remote service fails.
            for (const res of results) recordResult(res, true);
          }
        }

        // plan.create is a hard transaction boundary. Its successful handler
        // persists and displays the plan; returning immediately prevents a
        // stale pre-loop activePlan snapshot from nudging a duplicate plan and
        // prevents calls accidentally batched after plan.create from executing
        // before /implement approval.
        if (awaitingPlanApproval) {
          pendingCalls = [];
          return finishTurn("", productiveSteps);
        }

        if (aborted) {
          lastAnswer = "Aborted.";
          writeAbort();
          return finishTurn(lastAnswer, productiveSteps);
        }
        if (blocked && blockedResult) {
          lastAnswer = blockedResult.lastAnswer || "Blocked or Cancelled.";
          return finishTurn(lastAnswer, productiveSteps);
        }
        // A plain failure just stops the remaining calls; we fall through so
        // the model sees the failed tool's output and decides what to do next.

        // Compact older messages when the running estimate exceeds budget. Uses
        // the model-written summary path (with plan re-injection) — never a
        // mechanical transcript dump.
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

    // maxIterations ceiling reached (safety net — normally the step budget
    // gate with user confirmation handles stopping gracefully).
    const richSummary = await buildRichStopSummary(
      messages,
      session,
      productiveSteps,
    );
    writeAssistantMessage(richSummary);
    lastAnswer = richSummary;
    return finishTurn(lastAnswer, productiveSteps);
  } catch (error) {
    const isAbort = isAbortError(error, options.signal);
    const msg = isAbort ? "Aborted." : `Error: ${error instanceof Error ? error.message : String(error)}`;
    if (options.onMessages) {
      try {
        options.onMessages(buildTurnHistory(liveMessages, msg));
      } catch {
        // ignore
      }
    }
    if (isAbort) {
      writeAbort();
      return "Aborted.";
    }
    emit({
      type: "turn-error",
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
