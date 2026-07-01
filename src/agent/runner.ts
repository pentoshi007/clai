import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { mkdir, writeFile, chown } from "node:fs/promises";
import { homedir } from "node:os";
import { fixOwner, handlePermissionError } from "../os/permissions.js";

import { join, resolve } from "node:path";
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
} from "../prompts/index.js";
import { getConfig } from "../store/config.js";
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
import { reduceToolOutput } from "../tools/policies/output-policy.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
} from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { loadScope, isScopeActive, targetInScope } from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  createThinkingStreamParser,
  rememberThinkingFromText,
  renderThinkingSummary,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner, type ThinkingSpinner } from "../ui/spinner.js";
import { safeCwd } from "../os/cwd.js";
import { analyzeTask } from "./task-analyzer.js";
import { LoopGuard } from "./loop-guard.js";
import {
  createPlan,
  loadPlan,
  savePlan,
  markTask,
  type SessionPlan,
  type TaskState,
} from "../store/plan.js";
import { renderPlanChecklist, renderPlanSidePane } from "../ui/plan-pane.js";
import type { AgentEvent } from "./events.js";
import { pathInsideSandbox } from "../tools/fs.js";
import {
  stripSentinelTokens,
  parseToolCall,
  recognizeBareToolJson,
  looksLikeTruncatedToolCall,
  countToolFences,
  parseAllToolCalls,
  groupToolCallsForExecution,
  buildTurnHistory,
  collapseRepeatedText,
  textBeforeToolCall,
  formatToolArgs,
  looksLikePentestTask,
  looksLikeBuildTask,
  looksLikeActionNarration,
  looksLikePlanNarration,
  requiresFreshWebSearch,
  isLumpedSingleTask,
  freshnessGuardMessage,
  buildWorkflowDirective,
  shouldDimToolChatter,
} from "./tool-call-parser.js";
// Re-exported so existing imports of these names from "./runner.js" keep
// working unchanged — the parsing/classification engine now lives in
// tool-call-parser.ts.
export * from "./tool-call-parser.js";

/** Render the plan as a right-side pane on wide terminals, else inline. */
function renderPlanForTerminal(plan: SessionPlan): string {
  const cols = process.stdout.columns ?? 0;
  const side = process.stdout.isTTY
    ? renderPlanSidePane(plan, cols)
    : undefined;
  return side ?? renderPlanChecklist(plan);
}

export interface SessionPolicy {
  /** Tools the user authorized once during this REPL session. Not persisted. */
  allow: Set<string>;
  /** Mutable flag so the runner can flip pentest auth for this session only. */
  pentestAuthorized: { value: boolean };
  /** Stable id used to scope the session's plan/tasks in the plan store. */
  sessionId: string;
  /** When true, the agent must follow its approved plan (set by /implement). */
  planApproved: { value: boolean };
}

export function createSessionPolicy(sessionId?: string): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
    sessionId:
      sessionId ??
      `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    planApproved: { value: false },
  };
}

export interface ConfirmPort {
  confirmTool(call: ToolCall): Promise<boolean>;
  confirmPentest(): Promise<boolean>;
  /** Ask the user whether to continue after hitting the step budget. */
  confirmContinue?(steps: number): Promise<boolean>;
  /**
   * Ask whether to leave ask mode and run an action task in agent mode.
   * Optional so existing ports keep working; ask-mode handoff falls back to a
   * default "no" when a port doesn't implement it.
   */
  confirmAgentSwitch?(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean>;
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

/**
 * Re-assert raw mode AND resume stdin after an inquirer prompt
 * (confirm/password). inquirer's readline interface pauses stdin and
 * switches it to cooked mode when it closes; if we only flip raw mode back
 * on but leave stdin paused, no `keypress`/`data` events flow to the REPL's
 * ESC/Ctrl+C abort handler — so a long-running tool launched right after a
 * confirmation can no longer be aborted (the user had to kill the terminal).
 * Calling resume() restores the event flow.
 */
function restoreInteractiveStdin(): void {
  if (!process.stdin.isTTY) return;
  try {
    if (!(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

/**
 * Build a rich summary when the agent stops (user declined to continue or
 * maxIterations ceiling hit). Includes plan state, key findings, and clear
 * resume instructions so a later "continue" can pick up exactly here.
 */
async function buildRichStopSummary(
  messages: ChatMessage[],
  session: SessionPolicy,
  steps: number,
): Promise<string> {
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  const parts: string[] = [];

  parts.push(`Session paused after ${steps} steps.\n`);

  // Plan state
  if (plan) {
    parts.push("## Plan Status");
    parts.push(`Goal: ${plan.goal}`);
    for (const task of plan.tasks) {
      const icon =
        task.state === "done"
          ? "✓"
          : task.state === "in_progress"
            ? "▶"
            : task.state === "failed"
              ? "✗"
              : task.state === "skipped"
                ? "↷"
                : "·";
      parts.push(
        `  ${icon} [${task.id}] (${task.state}) ${task.title}${task.note ? ` — ${task.note}` : ""}`,
      );
    }
    const next = plan.tasks.find(
      (t) => t.state === "pending" || t.state === "in_progress",
    );
    if (next) {
      parts.push(`\nNext task to resume: ${next.id} — "${next.title}"`);
    }
    const doneCount = plan.tasks.filter((t) => t.state === "done").length;
    parts.push(`\nProgress: ${doneCount}/${plan.tasks.length} tasks done.`);
  }

  // Key findings from tool results (last 20 tool messages)
  const toolMsgs = messages.filter((m) => m.role === "tool").slice(-20);
  if (toolMsgs.length > 0) {
    parts.push("\n## Key Findings So Far");
    for (const msg of toolMsgs) {
      const firstLine = msg.content.split("\n")[0] ?? "";
      // Extract tool name from the structured format "Tool <name> result ..."
      const toolMatch = firstLine.match(/^Tool (\S+) result/);
      if (toolMatch) {
        parts.push(`- ${toolMatch[1]}: ${firstLine.slice(0, 150)}`);
      } else {
        parts.push(`- ${firstLine.slice(0, 150)}`);
      }
    }
  }

  parts.push("\n## To Resume");
  parts.push('Type "continue" to pick up from where this session left off.');

  return parts.join("\n");
}

/**
 * Tools allowed while an UN-approved plan is active. Before the user runs
 * /implement, the agent may only (re)create the plan and do read-only
 * exploration to refine it — never execute. Everything else is blocked by
 * the plan-awaiting-approval gate so a stray/recovered tool call can't start
 * running the plan, and so free-text after a plan is treated as a revision.
 */
const PRE_APPROVAL_ALLOWED_TOOLS = new Set<string>([
  "plan.create",
  "task.update",
  "fs.read",
  "fs.list",
  "fs.search",
  "sysinfo",
  "tool.batch",
  "net.context",
]);

export function isPreApprovalAllowedTool(name: string): boolean {
  return PRE_APPROVAL_ALLOWED_TOOLS.has(name);
}

export function styleToolChatter(call: ToolCall, text: string): string {
  return shouldDimToolChatter(call) ? chalk.dim(text) : text;
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
}

/** OCR is opt-in when real image pixels are already attached to the model. */
export function shouldEnableImageOcr(
  prompt: string,
  hasAttachedImages: boolean,
): boolean {
  if (!hasAttachedImages) return true;
  return /\b(?:ocr|optical character recognition|tesseract)\b/i.test(prompt);
}

function safeArtifactName(name: string): string {
  return (
    name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") ||
    "tool-output"
  );
}

async function saveToolOutput(
  call: ToolCall,
  output: string,
): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  const dir = join(homedir(), ".clai", "outputs");
  try {
    await mkdir(dir, { recursive: true });
    await fixOwner(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
    await writeFile(path, `${output}\n`, "utf8");
    await fixOwner(path);
    return path;
  } catch (err: any) {
    handlePermissionError(err);
  }
}

function summarizeOutput(
  output: string,
  maxChars = 8_000,
): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const lines = output.split(/\r?\n/);
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const half = Math.floor(maxChars / 2);

  for (const line of lines) {
    const cost = line.length + 1;
    if (used + cost > half) break;
    head.push(line);
    used += cost;
  }

  used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const cost = line.length + 1;
    if (used + cost > half) break;
    tail.unshift(line);
    used += cost;
  }

  return {
    text: [
      ...head,
      `... (${lines.length.toLocaleString()} output lines truncated) ...`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

// Tools whose output is the actual content the model needs verbatim (file
// bodies, listings, search hits). Running these through the security-signal
// `genericReducer` was wrong: it ranks lines by pentest keywords and drops
// the rest, so source code came back as a fragmentary head+tail — the model
// saw a "truncated" file and kept re-reading it in wasted retries. For these
// we pass the raw content through (up to a generous cap) and point the model
// at the saved artifact when it exceeds the cap.
const PASSTHROUGH_TOOLS = new Set<string>([
  "fs.read",
  "fs.list",
  "fs.search",
  "fs.edit",
  "pdf.read",
]);
const PASSTHROUGH_CAP_CHARS = 400_000;
// web.fetch/http.fetch pull in arbitrary third-party pages/API responses that
// can be hundreds of KB (e.g. a large OpenAPI spec). Unlike local files the
// model asked to read, this content is never bounded by the user's own
// project, so it must be capped like every other tool's context output —
// otherwise a single fetch can single-handedly blow the context budget and
// starve the model of room to actually respond (observed as empty/garbled
// completions on smaller-context-window models after a big fetch).
const WEB_FETCH_CAP_CHARS = 20_000;

function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) return "";
  if (call.name === "web.fetch" || call.name === "http.fetch") {
    const { text, truncated } = summarizeOutput(output, WEB_FETCH_CAP_CHARS);
    if (!truncated) return text;
    const saved = result.outputPath
      ? `\n\n[Response exceeds ${WEB_FETCH_CAP_CHARS.toLocaleString()} chars; showing the head and tail. The FULL response is saved at: ${result.outputPath} — re-fetch a narrower URL or read the saved file if you need the middle.]`
      : `\n\n[Response exceeds ${WEB_FETCH_CAP_CHARS.toLocaleString()} chars; only head and tail shown.]`;
    return `${text}${saved}`.trim();
  }
  // Pass-through tools: never reduce — the model needs the real content.
  if (PASSTHROUGH_TOOLS.has(call.name)) {
    const { text, truncated } = summarizeOutput(output, PASSTHROUGH_CAP_CHARS);
    if (!truncated) return text;
    const saved = result.outputPath
      ? `\n\n[File content exceeds ${PASSTHROUGH_CAP_CHARS.toLocaleString()} chars; showing the head and tail. The FULL content is saved at: ${result.outputPath} — re-read specific line ranges with fs.read if you need the middle.]`
      : `\n\n[File content exceeds ${PASSTHROUGH_CAP_CHARS.toLocaleString()} chars; only head and tail shown. Read it in smaller chunks if the middle is needed.]`;
    return `${text}${saved}`.trim();
  }
  let reduced: string | undefined;
  try {
    const command =
      call.name === "shell.exec" ? String(call.args.command ?? "") : call.name;
    const policy = reduceToolOutput(output, {
      toolName: call.name,
      command,
    });
    reduced = policy.summary.trim();
  } catch {
    reduced = undefined;
  }
  // Hard cap on the reduced text — reducers should already be small, but
  // never let one accidentally explode model context.
  const base = reduced && reduced.length > 0 ? reduced : output;
  const summary = summarizeOutput(base, 8_000);
  const saved = result.outputPath
    ? `\nFull output saved to: ${result.outputPath}`
    : "";
  return `${summary.text}${saved}`.trim();
}

const inquirerConfirmPort: ConfirmPort = {
  async confirmTool(call: ToolCall): Promise<boolean> {
    return confirm({
      message: chalk.yellow(`  run ${call.name}: ${formatToolArgs(call)}?`),
      default: true,
    });
  },
  async confirmPentest(): Promise<boolean> {
    return confirm({
      message: chalk.red(
        "clai only assists with security testing on systems you own or have written permission to test. Confirm for this session?",
      ),
      default: false,
    });
  },
  async confirmContinue(steps: number): Promise<boolean> {
    return confirm({
      message: chalk.yellow(`  ${steps} steps reached — continue?`),
      default: true,
    });
  },
  async confirmAgentSwitch(info: {
    reason: string;
    tools: string[];
  }): Promise<boolean> {
    const tools = info.tools.length > 0 ? ` (${info.tools.join(", ")})` : "";
    return confirm({
      message: chalk.yellow(
        `  this needs agent mode${tools} — switch and run it?`,
      ),
      default: true,
    });
  },
};

async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  if (!isPentestToolCall(call)) return true;
  // Persistent auth (via `clai authorize-pentest AGREE`) wins.
  if (getConfig().pentestAuthorized) return true;
  // Session auth flipped earlier in this session — no re-prompt.
  if (session.pentestAuthorized.value) return true;

  if (autoConfirm) {
    // -y is session-scoped only. We do NOT touch the persistent config so
    // a one-shot `-y` cannot silently authorize later interactive runs.
    session.pentestAuthorized.value = true;
    return true;
  }

  const ok = await confirmPort.confirmPentest();
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
  confirmPort: ConfirmPort,
): Promise<boolean> {
  const config = getConfig();
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirmPort.confirmTool(call);
}

interface PlanToolResult {
  handled: boolean;
  ok: boolean;
  plan?: SessionPlan | undefined;
  /** What to print to the user's terminal. */
  display: string;
  /** What to feed back to the model as the tool result. */
  modelNote: string;
}

/** Build the system-context block describing the session's active plan. */
function planContextMessage(plan: SessionPlan, approved: boolean): string {
  const lines: string[] = [];
  lines.push(
    `ACTIVE PLAN for this session (goal: ${plan.goal}, status: ${plan.status}):`,
  );
  if (plan.detail.trim()) lines.push(plan.detail.trim());
  lines.push("Tasks:");
  plan.tasks.forEach((t, i) => {
    lines.push(`  ${i + 1}. [${t.id}] (${t.state}) ${t.title}`);
  });
  if (approved) {
    const firstPending = plan.tasks.find((t) => t.state === "pending");
    lines.push("The user APPROVED this plan. Execute it task by task NOW.");
    if (firstPending) {
      lines.push(
        `START WITH TASK ${firstPending.id} (${firstPending.title}). ` +
          "Do NOT re-do tasks already marked done, and do NOT skip ahead to later tasks.",
      );
    }
    lines.push(
      "STRICT ORDER: call task.update {taskId, state:'in_progress'} → do the real work → " +
        "call task.update {taskId, state:'done'} ONLY after the tool calls actually succeed. " +
        "If a tool fails, mark the task 'failed' with a note, fix the problem, then retry. " +
        "Do NOT mark a task done when its commands error out. " +
        "Never claim something ran without a successful tool call.",
    );
  } else {
    lines.push(
      "This plan is NOT yet approved, so you MUST NOT execute any of its tasks yet. " +
        "Any new free-text message from the user right now is a PLAN REVISION, not approval — even if it " +
        "sounds like an instruction (e.g. 'do not install new tools', 'use only X', 'also add Y', 'skip task 2'). " +
        "Treat it as feedback: call plan.create AGAIN with the revised goal/detail/tasks to produce an updated " +
        "plan, then STOP and wait. Do NOT call shell.exec, pkg.install, net.scan, tool.check, fs.write, or any " +
        "other execution tool. The user will APPROVE with /implement, or CANCEL with /discard. Only after " +
        "/implement may you begin executing.",
    );
  }
  return lines.join("\n");
}

/**
 * Handle plan.create / task.update inline. These are session-scoped and
 * persisted via the plan store so the user can view the plan (Ctrl+P) and
 * the agent keeps it in context across the whole session.
 */
async function handlePlanTool(
  call: ToolCall,
  session: SessionPolicy,
  ctx: { loopGuard: LoopGuard; step: number },
): Promise<PlanToolResult> {
  void ctx;
  if (call.name === "plan.create") {
    const goal = typeof call.args.goal === "string" ? call.args.goal : "";
    const detail = typeof call.args.detail === "string" ? call.args.detail : "";
    const kind =
      typeof call.args.kind === "string" ? call.args.kind : "general";
    const rawTasks = Array.isArray(call.args.tasks) ? call.args.tasks : [];
    const taskTitles = rawTasks
      .map((t) => (typeof t === "string" ? t : ""))
      .filter(Boolean);
    if (!goal || taskTitles.length === 0) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create needs a non-empty goal and at least one task title\n",
        ),
        modelNote:
          "plan.create failed: provide a string goal and a non-empty tasks array of step titles.",
      };
    }
    // Reject a low-quality "everything in one step" plan. A single task that
    // itself enumerates many files/actions (commas, "and", slashes) is a sign
    // the model lumped the whole build into one checkbox — split it so the
    // user gets a real, trackable checklist and the executor works step by step.
    if (isLumpedSingleTask(taskTitles)) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          "  ✗ plan.create: that single task lumps the whole build into one step\n",
        ),
        modelNote:
          "plan.create rejected: you put everything into ONE task. Break it into 3-8 SEPARATE, " +
          "ordered tasks — each a distinct action, e.g. 'scaffold package.json + vite config', " +
          "'create index.html + entry (main.jsx)', 'build App + Post components', 'add posts data + styles', " +
          "'install deps and run dev server to verify'. Call plan.create again with that tasks array.",
      };
    }
    const plan = createPlan({
      sessionId: session.sessionId,
      goal,
      detail,
      taskTitles,
      kind,
    });
    await savePlan(plan).catch(() => undefined);
    // A freshly (re)created plan resets approval — the user must /implement.
    session.planApproved.value = false;
    const checklist = renderPlanForTerminal(plan);
    const display =
      chalk.cyan("  ● planning\n") +
      checklist +
      "\n" +
      chalk.dim(
        "  ✦ plan created — press Ctrl+P to view it, /implement to approve and run it,\n" +
          "    or /discard to cancel it. Any other message refines this plan.\n",
      );
    return {
      handled: true,
      ok: true,
      plan,
      display,
      modelNote:
        `Plan saved with ${plan.tasks.length} task(s). STOP here and wait — produce NO other tool calls now. ` +
        "Do NOT start executing tasks until the user approves with /implement. " +
        "If the user's next message gives feedback instead of /implement, that is a REVISION: call plan.create " +
        "again with the updated plan and STOP again. The user may cancel the whole plan with /discard. " +
        "Only after /implement do you begin, working task by task, calling task.update to mark each " +
        "in_progress before and done after you finish it.",
    };
  }

  // task.update
  const plan = await loadPlan(session.sessionId).catch(() => undefined);
  if (!plan) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        "  ✗ task.update: no active plan — call plan.create first\n",
      ),
      modelNote:
        "task.update failed: there is no active plan. Call plan.create first.",
    };
  }
  const taskId = typeof call.args.taskId === "string" ? call.args.taskId : "";
  const stateRaw = typeof call.args.state === "string" ? call.args.state : "";
  const note = typeof call.args.note === "string" ? call.args.note : undefined;
  const validStates: TaskState[] = [
    "pending",
    "in_progress",
    "done",
    "failed",
    "skipped",
  ];
  if (!validStates.includes(stateRaw as TaskState)) {
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: state must be one of ${validStates.join(", ")}\n`,
      ),
      modelNote: `task.update failed: state must be one of ${validStates.join(", ")}.`,
    };
  }
  // Only one task may be in_progress at a time. This forces genuine
  // task-by-task execution: the model must close (done/failed/skipped) the
  // current task before opening the next one, instead of leaving a task
  // "in_progress" as an umbrella while it quietly works through the rest
  // of the plan underneath it.
  if (stateRaw === "in_progress") {
    const otherInProgress = plan.tasks.find(
      (t) => t.id !== taskId && t.state === "in_progress",
    );
    if (otherInProgress) {
      return {
        handled: true,
        ok: false,
        display: chalk.red(
          `  \u2717 task.update: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress\n`,
        ),
        modelNote:
          `task.update failed: task [${otherInProgress.id}] "${otherInProgress.title}" is still in_progress. ` +
          "Finish it first \u2014 call task.update with state 'done' (or 'failed'/'skipped' with a note) " +
          `for [${otherInProgress.id}] before starting [${taskId}].`,
      };
    }
  }
  const ok = markTask(plan, taskId, stateRaw as TaskState, note);
  if (!ok) {
    const ids = plan.tasks.map((t) => t.id).join(", ");
    return {
      handled: true,
      ok: false,
      display: chalk.red(
        `  ✗ task.update: unknown taskId "${taskId}" (have: ${ids})\n`,
      ),
      modelNote: `task.update failed: unknown taskId. Valid ids: ${ids}.`,
    };
  }
  if (plan.status === "draft" || plan.status === "approved") {
    plan.status = "in_progress";
  }
  const allDone = plan.tasks.every(
    (t) => t.state === "done" || t.state === "skipped" || t.state === "failed",
  );
  if (allDone) plan.status = "completed";
  await savePlan(plan).catch(() => undefined);
  const checklist = renderPlanForTerminal(plan);
  return {
    handled: true,
    ok: true,
    plan,
    display: checklist + "\n",
    modelNote: allDone
      ? "Task updated. ALL tasks are now finished. Verify the result and give your final summary."
      : "Task updated. Continue with the next pending task.",
  };
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
    const freshWebSearchRequired =
      !buildLikeTurn &&
      !pentestLikeTurn &&
      toolNames.includes("web.search") &&
      requiresFreshWebSearch(prompt);
    const systemSections = [renderAgentSystemPrompt(toolNames.join(", "))];
    if (projectContext) {
      systemSections.push(
        `Project context from .clai/context.md:\n${projectContext}`,
      );
    }
    if (freshWebSearchRequired) {
      systemSections.push(freshnessGuardMessage());
    }

    let provider = options.provider ?? config.defaultProvider;
    await ensureProviderConfigured(provider);
    let model = options.model ?? config.defaultModel;
    let lastAnswer = "";
    const session: SessionPolicy = options.session ?? createSessionPolicy();

    // ── Active plan context ────────────────────────────────────────────
    // If this session already has a plan, inject it so the model keeps it in
    // context. When the user has approved it (via /implement) we instruct the
    // agent to execute task by task; otherwise the agent should refine/wait.
    const activePlan = await loadPlan(session.sessionId).catch(() => undefined);
    if (activePlan) {
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
    if (buildLikeTurn && !activePlan) {
      systemSections.push(buildWorkflowDirective());
    }

    const fullSystemPrompt = systemSections.join("\n\n");
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

    // Track recent tool calls to detect models stuck in a loop calling the
    // same tool with the same arguments over and over (e.g. pentest.recon
    // called 3× on the same target without summarizing).
    const loopGuard = new LoopGuard();

    // Track consecutive thinking-only responses so we can nudge the model
    // to actually act instead of silently returning an empty answer.
    let emptyVisibleRetries = 0;

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

    // Guard against a model that NARRATES intent ("let me explore the
    // directory…") but emits no tool call, so nothing runs and the turn ends
    // prematurely. On build/scaffold/plan turns where nothing has executed yet,
    // we nudge it to emit a real tool call instead of accepting the narration
    // as a final answer. Bounded so a model that truly can't emit the format
    // still terminates.
    let actionIntentRetries = 0;

    // ── Multi-tool execution queue ─────────────────────────────────────
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

    // ── Step budget ───────────────────────────────────────────────────
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
          call.name === "fs.edit";
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
          if (planResult.plan) {
            writePlanUpdate(planResult.plan, planResult.display);
          }
          const result = { ok: planResult.ok, output: planResult.modelNote };
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

      if (
        activePlan &&
        !session.planApproved.value &&
        !isPreApprovalAllowedTool(call.name)
      ) {
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

      // ── Task-scoped execution gate ───────────────────────────────────
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

      const toolCallLine =
        chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`);
      writeToolCall(
        toolEventId,
        call,
        styleToolChatter(call, toolCallLine) + "\n",
      );

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
            writeNotice(
              "warn",
              "cancelled",
              chalk.yellow(`  ✗ cancelled`) + "\n",
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

      const TOOL_STALL_WARNING_MS = 60_000; // 1 minute
      const stallTimer = setTimeout(() => {
        if (!toolAc.signal.aborted) {
          writeNotice(
            "info",
            `${call.name} has been running for >60s — still waiting (ESC to abort)`,
            chalk.yellow(`  ⏳ ${call.name} still running — ESC to abort\n`),
          );
        }
      }, TOOL_STALL_WARNING_MS);

      try {
        result = await runToolCall(call, {
          signal: toolAc.signal,
          requestSecret: options.requestSecret,
          onOutput: (chunk) => {
            if (toolAc.signal.aborted) return;
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
          writeAbort();
          return {
            ok: false,
            call,
            result: { ok: false, output: "Aborted." },
            contextOutput: "Aborted.",
            lastAnswer: "Aborted.",
          };
        }
        const errMsg =
          toolError instanceof Error ? toolError.message : String(toolError);
        result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
      } finally {
        clearTimeout(stallTimer);
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

    // ── Automatic context compaction ───────────────────────────────────────
    // As a long turn accumulates tool outputs and reasoning, the context can
    // grow past what the model can hold. We proactively summarize the older
    // turns into a single continuation memory (the SAME model-written summary
    // the /compact command uses — never a mechanical transcript dump) and then
    // re-inject the ACTIVE PLAN so the agent never loses track of the plan,
    // what is done, and what remains. The estimate is chars/4; the budget is
    // deliberately conservative so we compact a little early rather than hit a
    // provider context-window error mid-task.
    const AUTO_COMPACT_TOKEN_BUDGET = 60_000;
    const AUTO_COMPACT_KEEP_RECENT = 12;
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
        maxTokens: 2_048,
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
        const afterTokens = estimateMessagesTokens(messages);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: afterTokens,
          reason,
        });
        writeNotice(
          "info",
          `context auto-compacted to fit the window (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)`,
          chalk.dim(
            `  ℹ context auto-compacted (~${beforeTokens.toLocaleString()} → ~${afterTokens.toLocaleString()} tokens)\n`,
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
      // ── Step budget gate: ask the user instead of hard-stopping ────────
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
        const spinner = writesDirectly
          ? startThinkingSpinner(streamLabel, options.signal)
          : noopSpinner;
        if (!writesDirectly) {
          emit({ type: "status", text: streamLabel });
        }
        let sawReasoning = false;
        let inThinking = false;
        let emittedThinkingStatus = false;
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
              messages,
              temperature: 0.2,
              // Reasoning models can spend a lot on hidden thinking; give
              // them headroom so the visible answer / tool call isn't
              // truncated to silence. The non-thinking budget must be large
              // enough for a single-file fs.write / multi-file fs.writeMany
              // payload — a truncated tool-call JSON fails to parse and leaks a
              // broken (and syntactically invalid) file. 8k was too small for a
              // full component, so allow more room for the visible tool call.
              maxTokens: config.thinking?.enabled ? 16_384 : 12_288,
              signal: options.signal,
              thinking: config.thinking,
            },
            (token) => {
              deltaParser?.push(token);
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

        // ── Empty-response recovery ───────────────────────────────────────
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
            messages.push({
              role: "assistant",
              content: collapseRepeatedText(completion.text),
            });
            // Keep nudges SHORT — cheap models lose the key instruction in long text.
            const buildNudge =
              buildLikeTurn && !activePlan
                ? "No visible output. Emit a ```tool block to call plan.create now. " +
                  "Do NOT hide tool calls in <think> tags — put them in the visible response."
                : "No visible output. Emit a ```tool block or give your final answer. " +
                  "Do NOT hide tool calls in <think> tags — put them in the visible response.";
            messages.push(recoveryUserMessage(buildNudge));
            continue;
          }
          // Exhausted retries — surface a clear notice instead of ending the
          // turn silently with no answer (which left the user staring at a
          // stopped spinner with no clue what happened).
          writeNotice(
            "warn",
            "model returned an empty response after retries — no answer produced",
            chalk.yellow(
              "  ⚠ model returned an empty response after retries — no answer produced\n",
            ),
          );
        } else {
          // Reset the counter on any successful visible output or recovered call.
          emptyVisibleRetries = 0;
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
              messages.push({
                role: "assistant",
                content: assistantText.visible,
              });
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
            messages.push({
              role: "assistant",
              content: assistantText.visible,
            });
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
          // (most common with a large multi-file fs.writeMany). Retrying with a
          // nudge to split the work is far better than rendering broken JSON as
          // a final answer and leaving the project half-created.
          if (looksLikeTruncatedToolCall(assistantText.visible)) {
            truncatedToolRetries += 1;
            if (truncatedToolRetries <= 3) {
              writeNotice(
                "warn",
                "tool call was cut off (output too long) — asking the model to retry in smaller pieces",
                chalk.yellow(
                  "  ⚠ tool call was cut off (output too long) — asking the model to retry in smaller pieces\n",
                ),
              );
              messages.push({
                role: "assistant",
                content: assistantText.visible,
              });
              messages.push({
                role: "user",
                content:
                  "Your previous tool call was cut off before it finished — the JSON was incomplete, so NOTHING ran. " +
                  "Retry now with a COMPLETE, valid ```tool block. " +
                  "If it was a large fs.writeMany, split it into SMALLER batches (3-5 files per call, and keep each file's content concise) " +
                  "so the whole JSON fits in one response. Do NOT claim any file was written until a tool call actually succeeds.",
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
            malformedFenceRetries += 1;
            if (malformedFenceRetries <= 3) {
              writeNotice(
                "warn",
                "tool block present but its JSON didn't parse — asking the model to re-emit valid JSON",
                chalk.yellow(
                  "  ⚠ tool block present but its JSON didn't parse — asking the model to re-emit valid JSON\n",
                ),
              );
              messages.push({
                role: "assistant",
                content: assistantText.visible,
              });
              messages.push({
                role: "user",
                content:
                  "Your previous message contained a ```tool block, but its JSON was INVALID, so NOTHING ran. " +
                  "Common causes: an extra or missing `}` / `]`, a trailing brace after the closing `}`, or unescaped quotes/newlines inside a string value. " +
                  'Re-emit ONE valid ```tool block of the exact form {"name":"<tool>","args":{...}} with balanced braces. ' +
                  "If it was a large fs.writeMany, split it into SMALLER batches (3-5 files) so the JSON is easy to keep valid. " +
                  "Do NOT claim any file was written until a tool call actually succeeds.",
              });
              continue;
            }
            // Exhausted retries — fall through to the normal path.
          }
          // Normal final-answer path: strip any stray sentinel tokens that
          // somehow leaked into prose so the answer renders cleanly.
          const cleaned = stripSentinelTokens(assistantText.visible);

          // ── Act, don't narrate ────────────────────────────────────────────
          // Build/scaffold/plan turns must DO something. If the model returns
          // prose with NO tool call, it is narrating intent ("Let me first
          // explore the directory…") or writing a PLAN as prose ("Goal: … Tasks:
          // … please approve") instead of calling a tool — accepting it as a
          // final answer ends the turn with nothing done and no real plan saved.
          // Nudge it to emit a real tool call, with a concrete example.
          const narratedAction = looksLikeActionNarration(cleaned);
          const wantsAction =
            buildLikeTurn ||
            pentestLikeTurn ||
            (activePlan && session.planApproved.value) ||
            freshWebSearchRequired ||
            narratedAction;
          const planNarrated =
            buildLikeTurn && !activePlan && looksLikePlanNarration(cleaned);
          if (
            wantsAction &&
            cleaned.trim().length > 0 &&
            actionIntentRetries < 3 &&
            (productiveSteps === 0 || planNarrated || narratedAction)
          ) {
            actionIntentRetries += 1;
            let nudge: string;
            if (activePlan && session.planApproved.value) {
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
              // It explored and/or wrote a plan as prose but never called
              // plan.create — emit the plan as a real tool call so the user gets
              // a checklist and the /implement gate.
              nudge =
                "You wrote the plan as PROSE but did NOT call plan.create, so no plan was saved and the user cannot /implement it. Emit it as a real tool call NOW — exactly one ```tool block:\n" +
                '```tool\n{"name":"plan.create","args":{"goal":"<short goal>","detail":"<stack/approach and how you\'ll verify>","tasks":["task 1","task 2","task 3"],"kind":"coding"}}\n```\n' +
                "Do not describe the plan again in prose — just emit the plan.create tool block.";
              writeNotice(
                "warn",
                "plan was written as text, not created — nudging it to call plan.create",
                chalk.yellow(
                  "  ⚠ plan was written as text, not created — nudging it to call plan.create\n",
                ),
              );
            } else {
              nudge =
                "You described what you will do but emitted NO ```tool block, so NOTHING actually happened — narration is not action. Emit a real tool call NOW. For this build task, explore first like this:\n" +
                '```tool\n{"name":"fs.list","args":{"path":"."}}\n```\n' +
                "Then read key files, and once you understand the directory, call plan.create. Every turn MUST contain a ```tool block until the task is done.";
              writeNotice(
                "warn",
                "described an action but emitted no tool call — nudging it to run one",
                chalk.yellow(
                  "  ⚠ described an action but emitted no tool call — nudging it to run one\n",
                ),
              );
            }
            messages.push({
              role: "assistant",
              content: assistantText.visible,
            });
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
            messages.push({
              role: "assistant",
              content: assistantText.visible,
            });
            messages.push({
              role: "user",
              content:
                freshnessGuardMessage() +
                " Reply with ONLY a fenced ```tool block for web.search now.",
            });
            continue;
          }
          // ── Premature-completion guard (approved plan still has work) ──────
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
              messages.push({
                role: "assistant",
                content: assistantText.visible,
              });
              messages.push({
                role: "user",
                content:
                  `You have NOT finished the approved plan: ${unfinished.length} task(s) remain ` +
                  `(${unfinished.map((t) => `[${t.id}] ${t.title}`).join("; ")}). ` +
                  `Do NOT claim the work is complete, that files were created, or that a server is running ` +
                  `unless a tool call actually succeeded and you saw the output. ` +
                  `Resume now with the NEXT task ${next.id} ("${next.title}"): call task.update {taskId:"${next.id}", state:"in_progress"}, ` +
                  `then do the real work with a tool call (fs.writeMany / shell.exec / shell.start), VERIFY it, and mark it done. ` +
                  `Continue task by task until EVERY task is actually finished.`,
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

        messages.push({
          role: "assistant",
          content: standardizedContent,
        });

        if (allCalls.length > 1) {
          writeNotice(
            "info",
            `${allCalls.length} tool calls in this message — running scoped (independent read-only lookups in parallel, everything else in order)`,
            chalk.dim(
              `  ℹ ${allCalls.length} tool calls — read-only lookups in parallel, the rest in order\n`,
            ),
          );
        }

        // ── Scoped-parallel batch execution ────────────────────────────────
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
        // parallel. The whole batch stops on the first abort, block, or failure
        // so the model always sees and reacts to an error.
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

        const recordResult = (res: {
          call: ToolCall;
          result: ToolResult;
          contextOutput: string;
          ok: boolean;
          lastAnswer?: string | undefined;
          blockOrCancel?: boolean | undefined;
        }): void => {
          messages.push({
            role: "tool",
            content: `Tool ${res.call.name} result (exit=${res.result.exitCode ?? 0}, ok=${res.result.ok}):\n${res.contextOutput}`,
          });
          productiveSteps += 1;
          if (res.lastAnswer === "Aborted.") aborted = true;
          else if (res.blockOrCancel) {
            blocked = true;
            blockedResult = res;
          } else if (!res.ok) failed = true;
        };

        const groups = groupToolCallsForExecution(
          allCalls,
          isParallelSafe,
          PARALLEL_LIMIT,
        );
        for (const group of groups) {
          if (aborted || blocked || failed) break;
          if (group.length === 1) {
            const id = `tool-${++nextToolEventId}`;
            const res = await executeSingleTool(
              group[0]!,
              id,
              options.signal || new AbortController().signal,
            );
            recordResult(res);
          } else {
            // Concurrent group — assign ids in document order, then push their
            // results in document order for a stable transcript.
            const ids = group.map(() => `tool-${++nextToolEventId}`);
            const results = await Promise.all(
              group.map((c, k) =>
                executeSingleTool(
                  c,
                  ids[k]!,
                  options.signal || new AbortController().signal,
                ),
              ),
            );
            for (const res of results) recordResult(res);
          }
        }

        if (aborted) {
          lastAnswer = "Aborted.";
          writeAbort();
          return lastAnswer;
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
    if (isAbortError(error, options.signal)) {
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
