import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChatMessage,
  ProviderId,
  ToolCall,
  ToolResult,
} from "../types.js";
import { streamWithProvider } from "../llm/router.js";
import { renderAgentSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import {
  classifyToolCall,
  isPentestToolCall,
  scopeHint,
  scopeTargetForToolCall,
} from "../safety/classifier.js";
import { availableToolNames, runToolCall } from "../tools/registry.js";
import { reduceToolOutput } from "../tools/policies/output-policy.js";
import { formatViewportHint, registerViewport } from "../ui/output-pane.js";
import { compactMessages, estimateMessagesTokens } from "./context-manager.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import {
  loadScope,
  isScopeActive,
  targetInScope,
} from "../store/scope.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import {
  rememberThinkingFromText,
  renderThinkingSummary,
} from "../ui/thinking.js";
import { renderMarkdown, indentAndWrapText } from "../ui/markdown.js";
import { startThinkingSpinner } from "../ui/spinner.js";
import { analyzeTask } from "./task-analyzer.js";
import { LoopGuard } from "./loop-guard.js";

export interface SessionPolicy {
  /** Tools the user authorized once during this REPL session. Not persisted. */
  allow: Set<string>;
  /** Mutable flag so the runner can flip pentest auth for this session only. */
  pentestAuthorized: { value: boolean };
}

export function createSessionPolicy(): SessionPolicy {
  return {
    allow: new Set(),
    pentestAuthorized: { value: false },
  };
}

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
  session?: SessionPolicy | undefined;
}

function tryParseCall(raw: string): ToolCall | undefined {
  try {
    const parsed = JSON.parse(raw.trim()) as Partial<ToolCall>;
    if (
      typeof parsed.name === "string" &&
      parsed.args &&
      typeof parsed.args === "object"
    ) {
      return {
        name: parsed.name,
        args: parsed.args as Record<string, unknown>,
      };
    }
  } catch {
    // not valid JSON
  }
  return undefined;
}

// Kimi K2 / Moonshot models on NVIDIA NIM emit tool calls using a
// sentinel-token format that looks like:
//   <|tool_calls_section_begin|>
//     <|tool_call_begin|>functions.shell.exec:0<|tool_call_argument_begin|>
//     {"command":"ls"}
//     <|tool_call_end|>
//   <|tool_calls_section_end|>
// The `functions.` prefix is optional, the trailing `:N` index is optional,
// and the surrounding section markers may be absent on truncated streams.
const KIMI_TOOL_CALL_RE =
  /<\|tool_call_begin\|>\s*(?:functions\.)?([A-Za-z][\w.]*?)(?::\d+)?\s*<\|tool_call_argument_begin\|>\s*(\{[\s\S]*?\})\s*<\|tool_call_end\|>/i;

function parseKimiToolCall(text: string): ToolCall | undefined {
  const match = text.match(KIMI_TOOL_CALL_RE);
  if (!match) return undefined;
  const name = match[1]!;
  return tryParseCall(JSON.stringify({ name, args: tryJson(match[2]!) ?? {} }));
}

function tryJson(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return undefined;
}

/** Strip any leftover Kimi/Moonshot sentinel tokens from final answers
 *  so a model that mixes prose and tool-call markers never bleeds raw
 *  `<|tool_call_begin|>` strings to the terminal. */
function stripSentinelTokens(text: string): string {
  return text
    .replace(
      /<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi,
      "",
    )
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi, "")
    .replace(/<\|tool_calls?(?:_section)?_(?:begin|end)\|>/gi, "")
    .replace(/<\|tool_call_argument_begin\|>/gi, "")
    .replace(/<\|tool_[a-z_]*\|>/gi, "")
    .trim();
}

export interface ParseToolCallOptions {
  /**
   * When true, only formats that are explicitly tool-call delimited are
   * accepted: ```tool fenced JSON, <tool_call> XML, and the Kimi sentinel
   * token format. Loose formats (any fenced block, heading-prefix, trailing
   * JSON) are dropped — useful when models routinely emit JSON examples in
   * prose. Default is `false` so existing free-tier models keep working.
   */
  strict?: boolean | undefined;
}

export function parseToolCall(
  text: string,
  options: ParseToolCallOptions = {},
): ToolCall | undefined {
  // 1. ```tool ... ``` (standard format)
  const fenced = text.match(/```tool\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const call = tryParseCall(fenced[1]);
    if (call) return call;
  }

  // 2. <tool_call>...</tool_call>
  const xml = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/i);
  if (xml?.[1]) {
    const call = tryParseCall(xml[1]);
    if (call) return call;
  }

  // 3. Kimi/Moonshot sentinel format (used by kimi-k2 family on NIM).
  const kimi = parseKimiToolCall(text);
  if (kimi) return kimi;

  // In strict mode, stop here. Headings, generic fenced blocks, and trailing
  // JSON are too easy to accidentally trigger when the model is showing a
  // worked example.
  if (options.strict) return undefined;

  // 4. ### tool / ## tool / # tool heading + JSON
  const heading = text.match(/#{1,3}\s*tool\s*\n\s*(\{[\s\S]*\})/i);
  if (heading?.[1]) {
    const call = tryParseCall(heading[1]);
    if (call) return call;
  }

  // 5. **tool** heading + JSON
  const bold = text.match(/\*\*tool\*\*\s*\n\s*(\{[\s\S]*\})/i);
  if (bold?.[1]) {
    const call = tryParseCall(bold[1]);
    if (call) return call;
  }

  // 6. Any fenced block (```json, ```, etc.) containing name+args
  const anyFenced = text.match(/```\w*\s*\n?([\s\S]*?)```/);
  if (anyFenced?.[1]) {
    const call = tryParseCall(anyFenced[1]);
    if (call) return call;
  }

  // 7. Trailing JSON object with "name" and "args"
  const trailingJson = text.match(
    /(\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\})\s*$/,
  );
  if (trailingJson?.[1]) {
    const call = tryParseCall(trailingJson[1]);
    if (call) return call;
  }

  return undefined;
}

/** Extract the text before the tool call block for display purposes */
function textBeforeToolCall(text: string): string {
  const patterns = [
    /```tool\s*\n?[\s\S]*?```/i,
    /<tool_call>[\s\S]*?<\/tool_call>/i,
    // Kimi/Moonshot sentinel block — strip from the section opener
    // (or the first call opener if the section header is missing).
    /<\|tool_calls_section_begin\|>[\s\S]*$/i,
    /<\|tool_call_begin\|>[\s\S]*$/i,
    /#{1,3}\s*tool\s*\n\s*\{[\s\S]*\}/i,
    /\*\*tool\*\*\s*\n\s*\{[\s\S]*\}/i,
    /```\w*\s*\n?\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?```/,
    /\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\}\s*$/,
  ];
  for (const pattern of patterns) {
    const idx = text.search(pattern);
    if (idx >= 0) {
      return text.slice(0, idx).trim();
    }
  }
  return text.trim();
}

function formatToolArgs(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  if (call.name === "net.scan")
    return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "dns.lookup")
    return `${call.args.target ?? ""}${call.args.record ? ` ${call.args.record}` : " A"}`;
  if (call.name === "whois.lookup") return String(call.args.target ?? "");
  if (call.name === "fs.read" || call.name === "fs.write")
    return String(call.args.path ?? "");
  if (call.name === "fs.search") return String(call.args.pattern ?? "");
  if (call.name === "http.fetch") return String(call.args.url ?? "");
  if (call.name === "pkg.install") return String(call.args.tool ?? "");
  if (call.name === "fs.list") return String(call.args.path ?? process.cwd());
  return JSON.stringify(call.args);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return (
    Boolean(signal?.aborted) ||
    (error instanceof Error && error.name === "AbortError")
  );
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
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
  await writeFile(path, `${output}\n`, "utf8");
  return path;
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

function formatToolContext(call: ToolCall, result: ToolResult): string {
  const output = result.output.trim();
  if (!output) return "";
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

async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
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

  const ok = await confirm({
    message: chalk.red(
      "clai only assists with security testing on systems you own or have written permission to test. Confirm for this session?",
    ),
    default: false,
  });
  if (!ok) return false;
  session.pentestAuthorized.value = true;
  return true;
}

async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
  session: SessionPolicy,
): Promise<boolean> {
  const config = getConfig();
  if (autoConfirm) return true;
  if (session.allow.has(call.name)) return true;
  // Persistent allowlist kept for backwards compat with users who set it
  // through `clai config` directly, but `/allow` only mutates the session
  // set so authorizations never leak across processes.
  if (config.allowAlwaysTools.includes(call.name)) return true;

  return confirm({
    message: chalk.yellow(`  run ${call.name}: ${formatToolArgs(call)}?`),
    default: true,
  });
}

export async function runAgentLoop(
  prompt: string,
  options: AgentRunOptions = {},
): Promise<string> {
  const config = getConfig();
  const maxSteps = options.maxSteps ?? 30;
  const projectContext = await loadProjectContext();
  const systemPrompt = renderAgentSystemPrompt(availableToolNames().join(", "));
  const fullSystemPrompt = projectContext
    ? `${systemPrompt}\n\nProject context from .clai/context.md:\n${projectContext}`
    : systemPrompt;
  const messages: ChatMessage[] = [
    { role: "system", content: fullSystemPrompt },
    ...(options.history ?? []),
    { role: "user", content: prompt },
  ];

  let provider = options.provider ?? config.defaultProvider;
  await ensureProviderConfigured(provider);
  let model = options.model ?? config.defaultModel;
  let lastAnswer = "";
  const session: SessionPolicy = options.session ?? createSessionPolicy();

  // Track recent tool calls to detect models stuck in a loop calling the
  // same tool with the same arguments over and over (e.g. pentest.recon
  // called 3× on the same target without summarizing).
  const loopGuard = new LoopGuard();

  // Track consecutive thinking-only responses so we can nudge the model
  // to actually act instead of silently returning an empty answer.
  let emptyVisibleRetries = 0;

  // ── Complexity-based step limit (no hardcoded plans) ──────────────
  const analysis = analyzeTask(prompt);
  const dynamicMaxSteps =
    analysis.complexity === "simple" ? 10
    : analysis.complexity === "standard" ? 20
    : maxSteps;

  for (let step = 0; step < dynamicMaxSteps; step += 1) {
    options.signal?.throwIfAborted();
    // Buffer LLM output so tool JSON and hidden thinking are not printed raw.
    // Status messages (rate-limit retries, fallback hints) still surface live.
    // A spinner gives the user feedback during long thinking phases on
    // models like glm-5.1 / deepseek-v4-flash that stream reasoning first.
    const spinner = startThinkingSpinner(
      step === 0 ? "waiting for model" : `step ${step + 1}`,
      options.signal,
    );
    let sawReasoning = false;
    let inThinking = false;
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
          // truncated to silence. Keep the no-thinking default lean so
          // fast models like kimi-k2.6 respond instantly.
          maxTokens: config.thinking?.enabled ? 8_192 : 4_096,
          signal: options.signal,
          thinking: config.thinking,
        },
        (token) => {
          // Heuristic: <think>… markers and reasoning_content tokens flow
          // through onToken. Surface activity in the spinner so the screen
          // is never empty for minutes.
          if (!sawReasoning && /<think/i.test(token)) {
            sawReasoning = true;
            inThinking = true;
            spinner.setLabel("thinking");
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
          process.stdout.write(chalk.dim(status));
        },
      );
    } finally {
      // Always clear the spinner — abort, network error, or success.
      spinner.stop();
    }
    provider = completion.provider;
    model = completion.model;

    const assistantText = rememberThinkingFromText(completion.text);

    // ── Thinking-only recovery ────────────────────────────────────────
    // Some models (eg gpt-oss-20b on NVIDIA NIM) occasionally spend their
    // entire budget on hidden <think> reasoning and emit no visible text
    // or tool call. Without this guard the agent silently returns an empty
    // answer and the user has to re-submit the same prompt.
    if (!assistantText.visible.trim() && assistantText.hasThinking) {
      emptyVisibleRetries += 1;
      if (emptyVisibleRetries <= 2) {
        process.stdout.write(
          `${renderThinkingSummary(assistantText.thinkContent)}\n`,
        );
        process.stdout.write(
          chalk.yellow(
            "  ⚠ model produced only thinking — nudging it to take action\n",
          ),
        );
        messages.push({ role: "assistant", content: completion.text });
        messages.push({
          role: "user",
          content:
            "You only produced internal reasoning with no visible answer or tool call. " +
            "You MUST either call a tool using the ```tool format or provide your final answer. " +
            "Do NOT just think — take action NOW.",
        });
        continue;
      }
      // Exhausted retries — fall through to the normal empty-answer path
      // which will print a warning and return.
    } else {
      // Reset the counter on any successful visible output.
      emptyVisibleRetries = 0;
    }

    const call = parseToolCall(assistantText.visible, {
      strict: getConfig().parserStrict,
    });
    if (!call) {
      // Detect the case where the model emitted sentinel-style tool-call
      // markers but the body was malformed or truncated. Printing those
      // raw tokens looks like a crash to the user — instead, ask the
      // model to retry the tool call in a clean JSON format.
      if (
        /<\|tool_call(?:s_section)?_begin\|>|<\|tool_call_argument_begin\|>/i.test(
          assistantText.visible,
        )
      ) {
        process.stdout.write(
          chalk.yellow(
            "  ⚠ tool call was malformed or cut off — asking the model to retry in JSON form\n",
          ),
        );
        messages.push({ role: "assistant", content: assistantText.visible });
        messages.push({
          role: "user",
          content:
            "Your previous tool call was malformed or truncated. " +
            "Reply with ONLY a fenced ```tool block containing valid JSON " +
            'of the form `{"name": "<tool>", "args": { ... }}`. ' +
            "Do not use <|tool_call_begin|> markers.",
        });
        continue;
      }
      // Normal final-answer path: strip any stray sentinel tokens that
      // somehow leaked into prose so the answer renders cleanly.
      const cleaned = stripSentinelTokens(assistantText.visible);
      if (cleaned) {
        process.stdout.write(renderMarkdown(cleaned));
        if (!cleaned.endsWith("\n")) process.stdout.write("\n");
      }
      if (assistantText.hasThinking) {
        process.stdout.write(
          `${renderThinkingSummary(assistantText.thinkContent)}\n`,
        );
      }
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = cleaned;
      return lastAnswer;
    }

    // ── Duplicate-call detection ──────────────────────────────────────────
    // If the model calls the exact same tool with the exact same args
    // repeatedly, it's stuck in a loop. Inject a corrective message
    // telling it to summarize the results it already has.
    const loopCheck = loopGuard.shouldBlock(call.name, call.args);
    if (loopCheck.block) {
      process.stdout.write(
        chalk.yellow(
          `  ⚠ ${call.name} was already called with the same arguments — forcing summary\n`,
        ),
      );
      messages.push({ role: "assistant", content: assistantText.visible });
      messages.push({
        role: "user",
        content:
          `You already called ${call.name} with the same arguments and received results. ` +
          "Do NOT call it again. Summarize the findings you already have and give your final answer NOW.",
      });
      continue;
    }
    if (loopCheck.reason) {
      process.stdout.write(chalk.dim(`  ℹ ${loopCheck.reason}\n`));
    }

    // Print only non-thinking text before the tool call.
    const beforeTool = textBeforeToolCall(assistantText.visible);
    if (beforeTool) {
      process.stdout.write(renderMarkdown(beforeTool) + "\n");
    }
    if (assistantText.hasThinking) {
      process.stdout.write(
        `${renderThinkingSummary(assistantText.thinkContent)}\n`,
      );
    }

    messages.push({ role: "assistant", content: assistantText.visible });
    const scope = await loadScope();
    const decision = classifyToolCall(call, { scope });
    await auditLog("tool.classified", {
      call,
      decision,
      scope: isScopeActive(scope) ? scope.name ?? "(unnamed)" : "(none)",
    });

    // Show tool call
    process.stdout.write(
      chalk.cyan(`  ▶ ${call.name}`) +
        chalk.gray(` ${formatToolArgs(call)}`) +
        "\n",
    );

    const scopeTarget = scopeTargetForToolCall(call);
    if (
      scopeTarget &&
      (!isScopeActive(scope) || !targetInScope(scopeTarget, scope))
    ) {
      process.stdout.write(
        chalk.dim(`  scope optional: ${scopeHint(scopeTarget)}\n`),
      );
    }

    if (decision.level === "block") {
      process.stdout.write(chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n");
      lastAnswer = `Blocked: ${call.name} — ${decision.reason}`;
      return lastAnswer;
    }

    // Pentest authorization — if user confirms this, skip the per-tool confirm
    let pentestJustConfirmed = false;
    const needsPentestAuth =
      isPentestToolCall(call) &&
      !getConfig().pentestAuthorized &&
      !session.pentestAuthorized.value;
    const authorized = await ensurePentestAuthorization(
      call,
      Boolean(options.autoConfirm),
      session,
    );
    // inquirer's confirm() creates its own readline interface which resets
    // raw mode when it finishes. Re-assert raw mode so the outer keypress
    // handler (ESC/Ctrl+C abort, Ctrl+O output pane) keeps working during
    // the next streaming phase.
    if (process.stdin.isTTY && !(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
      try { process.stdin.setRawMode(true); } catch { /* ignore */ }
    }
    if (!authorized) {
      lastAnswer = "Pentest authorization not confirmed.";
      process.stdout.write(chalk.red(`  ✗ ${lastAnswer}`) + "\n");
      return lastAnswer;
    }
    if (needsPentestAuth) {
      pentestJustConfirmed = true;
    }

    // Confirm if needed (safe tools auto-execute, pentest-auth'd tools skip)
    // fs.delete and shell deletions NEVER auto-confirm even with -y flag.
    const forceManualConfirm = call.name === "fs.delete";
    if (decision.level === "confirm" && !pentestJustConfirmed) {
      const ok = await confirmToolExecution(
        call,
        forceManualConfirm ? false : Boolean(options.autoConfirm),
        session,
      );
      // Re-assert raw mode after inquirer's confirm() (see comment above).
      if (process.stdin.isTTY && !(process.stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw) {
        try { process.stdin.setRawMode(true); } catch { /* ignore */ }
      }
      if (!ok) {
        lastAnswer = "Cancelled.";
        process.stdout.write(chalk.yellow(`  ✗ cancelled`) + "\n");
        return lastAnswer;
      }
    }

    // Execute tool
    options.signal?.throwIfAborted();
    options.onToolStart?.(call);
    let result: ToolResult;
    let liveBytes = 0;
    const liveCap = 16_000; // Stop streaming after this many bytes to avoid flooding the terminal.
    let liveTruncatedNotified = false;
    let lastProgressAt = 0;
    const printLive = (chunk: string): void => {
      // Suppress live preview for fs.read / fs.list — those are read-only
      // and the final summary is already concise. Stream shell-style tools
      // (shell.exec, net.scan, pentest.recon, pkg.install).
      if (
        call.name === "fs.read" ||
        call.name === "fs.list" ||
        call.name === "fs.search"
      )
        return;
      if (liveBytes >= liveCap) {
        if (!liveTruncatedNotified) {
          liveTruncatedNotified = true;
          process.stdout.write(
            chalk.dim("\n  … live preview truncated, full output saved\n"),
          );
          process.stdout.write(
            chalk.dim("  (tool still running — ESC or Ctrl+C to abort)\n"),
          );
          lastProgressAt = Date.now();
        }
        // After truncation, show a dot every 5 seconds so the user knows
        // the tool is still running and the terminal isn't frozen.
        const now = Date.now();
        if (now - lastProgressAt > 5_000) {
          lastProgressAt = now;
          process.stdout.write(chalk.dim("."));
        }
        return;
      }
      const remaining = liveCap - liveBytes;
      const slice =
        chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      liveBytes += slice.length;
      // Indent each line so live output lines up under the tool call.
      const indented = slice.replace(/\r/g, "").replace(/\n(?!$)/g, "\n  ");
      process.stdout.write(
        chalk.dim(
          indented.startsWith("\n")
            ? indented
            : `  ${indented}`.replace(/^  /, "  "),
        ),
      );
    };

    try {
      result = await runToolCall(call, {
        signal: options.signal,
        onOutput: (chunk) => {
          if (options.signal?.aborted) return;
          printLive(chunk);
        },
      });
      // Newline separator if live output or progress dots didn't already end with one.
      if (liveBytes > 0 || liveTruncatedNotified) process.stdout.write("\n");
    } catch (toolError) {
      if (isAbortError(toolError, options.signal)) {
        lastAnswer = "Aborted.";
        process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
        return lastAnswer;
      }
      const errMsg =
        toolError instanceof Error ? toolError.message : String(toolError);
      result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
    }
    const output = result.output.trim();
    const displayMax = 6_000;
    // If the tool already produced an artifact (shell.exec now streams to one
    // as it runs), respect that path. Otherwise, fall back to the post-hoc
    // save for tools that return their full output in memory.
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
    options.onToolResult?.(call, resultWithArtifact);
    await auditLog("tool.result", {
      call,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output.slice(0, 4_000),
    });

    // Record the attempt in the loop guard for dedup tracking.
    loopGuard.recordAttempt(step, call.name, call.args, result.ok, result.exitCode);

    // ── Auto-retry on "command not found" ──────────────────────────
    // Detect missing tools and instruct the model to install + retry.
    const NOT_FOUND_RE = /command not found|ENOENT.*spawn|is not recognized/i;
    if (!result.ok && NOT_FOUND_RE.test(output)) {
      const cmdName = call.name === "shell.exec"
        ? String(call.args.command ?? "").split(/\s+/)[0]
        : call.name === "net.scan" ? "nmap" : undefined;
      if (cmdName) {
        process.stdout.write(
          chalk.yellow(`  ⚠ ${cmdName} not found — asking model to install and retry\n`),
        );
        messages.push({
          role: "tool",
          content:
            `Tool failed: "${cmdName}" is not installed.\n` +
            `You MUST: 1) use pkg.install to install "${cmdName}", ` +
            `2) then RETRY the original command. Do NOT stop or give up.`,
        });
        continue;
      }
    }

    // Print tool result
    const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
    process.stdout.write(statusIcon + "\n");
    if (output) {
      const displaySummary = summarizeOutput(output, displayMax);
      const displayText = displaySummary.truncated
        ? `${displaySummary.text}${savedOutputPath ? chalk.dim(`\n  ... full output saved to ${savedOutputPath}`) : chalk.dim("\n  ... output truncated")}`
        : displaySummary.text;
      // If we already streamed live output for this call, skip re-printing
      // the same bytes. Just note where the full output lives if it was saved.
      if (liveBytes > 0) {
        if (savedOutputPath) {
          process.stdout.write(
            chalk.dim(`  full output saved to ${savedOutputPath}\n`),
          );
        }
      } else {
        process.stdout.write(indentAndWrapText(displayText) + "\n");
      }
    }
    if (isAbortError(undefined, options.signal)) {
      lastAnswer = "Aborted.";
      process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
      return lastAnswer;
    }

    const contextOutput = formatToolContext(call, resultWithArtifact);

    // Register a collapse/expand viewport so the user can pull the full raw
    // output back with Ctrl+O or `/output last` after the AI summary lands.
    if (output) {
      const viewport = registerViewport({
        toolName: call.name,
        argsDisplay: formatToolArgs(call),
        artifactPath: savedOutputPath,
        summary: contextOutput,
      });
      // Only print the Ctrl+O hint when there's a real artifact file
      // (large output saved to disk). Avoid spamming the hint for
      // every tiny tool call — the user can always use /output last.
      if (savedOutputPath) {
        process.stdout.write(`${formatViewportHint(viewport)}\n`);
      }
    }
    messages.push({
      role: "tool",
      content: `Tool ${call.name} result (exit=${result.exitCode ?? 0}, ok=${result.ok}):\n${contextOutput}`,
    });
    // Compact older messages when the running estimate exceeds budget so
    // free-tier context windows are not blown by long pentest sessions.
    if (estimateMessagesTokens(messages) > 24_000) {
      const compacted = compactMessages(messages);
      if (compacted.length < messages.length) {
        messages.splice(0, messages.length, ...compacted);
        await auditLog("agent.compact", {
          newLength: messages.length,
          estimatedTokens: estimateMessagesTokens(messages),
        });
      }
    }
  }

  lastAnswer = `Stopped after ${dynamicMaxSteps} steps.`;
  process.stdout.write("  " + chalk.yellow(lastAnswer) + "\n");
  return lastAnswer;
}
