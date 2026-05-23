import { confirm } from "@inquirer/prompts";
import chalk from "chalk";
import type {
  ChatMessage,
  ProviderId,
  ToolCall,
  ToolResult,
} from "../types.js";
import { streamWithProvider } from "../llm/router.js";
import { renderAgentSystemPrompt } from "../prompts/index.js";
import { getConfig, updateConfig } from "../store/config.js";
import { classifyToolCall, isPentestToolCall } from "../safety/classifier.js";
import { availableToolNames, runToolCall } from "../tools/registry.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { rememberThinkingFromText, renderThinkingSummary } from "../ui/thinking.js";
import { renderMarkdown } from "../ui/markdown.js";
import { startThinkingSpinner } from "../ui/spinner.js";
import { writeArtifact } from "../tools/artifacts.js";
import {
  createToolLivePane,
  hasToolOutputSnapshot,
  rememberToolOutput,
  renderToolOutputHint,
  updateLastToolSummary,
} from "../ui/tool-output.js";
import { compactMessagesForModel, wrapUntrustedContext } from "../context/manager.js";

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
  signal?: AbortSignal | undefined;
  onToolStart?: ((call: ToolCall) => void) | undefined;
  onToolResult?: ((call: ToolCall, result: ToolResult) => void) | undefined;
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

function callFromFencedPayload(lang: string, raw: string): ToolCall | undefined {
  const call = tryParseCall(raw);
  if (call) return call;

  const args = tryJson(raw);
  if (!args) return undefined;
  const normalizedLang = lang.toLowerCase();
  if (
    normalizedLang === "shell" ||
    normalizedLang === "bash" ||
    normalizedLang === "sh" ||
    normalizedLang === "shell.exec"
  ) {
    if (typeof args.command === "string") {
      return { name: "shell.exec", args };
    }
  }
  const knownToolNames = new Set([
    "fs.read",
    "fs.write",
    "fs.list",
    "fs.search",
    "pkg.install",
    "net.scan",
    "http.fetch",
    "sysinfo",
    "pentest.recon",
  ]);
  if (knownToolNames.has(normalizedLang)) {
    return { name: normalizedLang, args };
  }
  return undefined;
}

/** Strip any leftover Kimi/Moonshot sentinel tokens from final answers
 *  so a model that mixes prose and tool-call markers never bleeds raw
 *  `<|tool_call_begin|>` strings to the terminal. */
function stripSentinelTokens(text: string): string {
  return text
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?<\|tool_calls_section_end\|>/gi, "")
    .replace(/<\|tool_call_begin\|>[\s\S]*?<\|tool_call_end\|>/gi, "")
    .replace(/<\|tool_calls?(?:_section)?_(?:begin|end)\|>/gi, "")
    .replace(/<\|tool_call_argument_begin\|>/gi, "")
    .replace(/<\|tool_[a-z_]*\|>/gi, "")
    .trim();
}

export function parseToolCall(text: string): ToolCall | undefined {
  // 1. ```tool ... ``` (standard format)
  const fenced = text.match(/```tool\s*\n?([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const call = tryParseCall(fenced[1]);
    if (call) return call;
  }

  // Many free/open models ignore the requested `tool` fence language and
  // emit the same valid call in a ```json block. Accept fenced JSON, but
  // continue rejecting loose/trailing JSON prose below.
  for (const compatibleFenced of text.matchAll(/```([A-Za-z0-9_.-]+)\s*\n?([\s\S]*?)```/g)) {
    const lang = compatibleFenced[1];
    const payload = compatibleFenced[2];
    if (!lang || !payload) continue;
    const call = callFromFencedPayload(lang, payload);
    if (call) return call;
  }

  // 3. Kimi/Moonshot sentinel format (used by kimi-k2 family on NIM).
  // Keep this provider-specific compatibility path, but reject generic JSON
  // examples/headings/trailing objects so explanatory prose never executes.
  const kimi = parseKimiToolCall(text);
  if (kimi) return kimi;

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
    /```[A-Za-z0-9_.-]*\s*\n?\{[\s\S]*?"command"[\s\S]*?\}[\s\S]*?```/,
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
  if (call.name === "net.scan") return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}${call.args.flags ? ` ${call.args.flags}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "fs.read" || call.name === "fs.write") return String(call.args.path ?? "");
  if (call.name === "fs.search") return String(call.args.pattern ?? "");
  if (call.name === "http.fetch") return String(call.args.url ?? "");
  if (call.name === "pkg.install") return String(call.args.tool ?? "");
  if (call.name === "fs.list") return String(call.args.path ?? process.cwd());
  return JSON.stringify(call.args);
}

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (error instanceof Error && error.name === "AbortError");
}

async function saveToolOutput(call: ToolCall, output: string): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  return writeArtifact(call.name, output);
}

function summarizeOutput(output: string, maxChars = 8_000): { text: string; truncated: boolean } {
  if (output.length <= maxChars) return { text: output, truncated: false };

  const lines = output.split(/\r?\n/);
  const signalLines = lines.filter((line) =>
    /\b(open|vulnerable|critical|high|medium|found|success|injectable|CVE-\d{4}-\d+|200|201|204|301|302|307|308|401|403|500|error|failed)\b/i.test(
      line,
    ),
  );
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  const signalBudget = Math.floor(maxChars * 0.45);
  const half = Math.floor((maxChars - signalBudget) / 2);

  const signals: string[] = [];
  for (const line of signalLines) {
    const cost = line.length + 1;
    if (used + cost > signalBudget) break;
    signals.push(line);
    used += cost;
  }

  used = 0;
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
      ...(signals.length > 0
        ? [`... high-signal lines from omitted output ...`, ...signals]
        : []),
      `... (${lines.length.toLocaleString()} output lines truncated) ...`,
      ...tail,
    ].join("\n"),
    truncated: true,
  };
}

function formatToolContext(result: ToolResult): string {
  const output = (result.modelContext ?? result.summary ?? result.output).trim();
  const summary = summarizeOutput(output, 8_000);
  const saved = result.outputPath ? `\nFull output saved to: ${result.outputPath}` : "";
  return `${summary.text}${saved}`.trim();
}

async function ensurePentestAuthorization(
  call: ToolCall,
  autoConfirm: boolean,
): Promise<boolean> {
  const config = getConfig();
  if (!isPentestToolCall(call) || config.pentestAuthorized) return true;

  if (autoConfirm) {
    return true;
  }

  const ok = await confirm({
    message: chalk.red("clai only assists with security testing on systems you own or have written permission to test. Confirm?"),
    default: false,
  });
  if (!ok) return false;
  updateConfig({ pentestAuthorized: true });
  return true;
}

async function confirmToolExecution(
  call: ToolCall,
  autoConfirm: boolean,
): Promise<boolean> {
  const config = getConfig();
  if (autoConfirm || config.allowAlwaysTools.includes(call.name)) return true;

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
    ? `${systemPrompt}\n\n${wrapUntrustedContext("Project context from .clai/context.md", projectContext)}`
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

  for (let step = 0; step < maxSteps; step += 1) {
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
    let completion;
    try {
      completion = await streamWithProvider(
        {
          provider,
          model,
          messages: compactMessagesForModel(messages),
          temperature: 0.2,
          // Reasoning models can spend a lot on hidden thinking; give
          // them headroom so the visible answer / tool call isn't
          // truncated to silence. Keep the no-thinking default lean so
          // fast models like kimi-k2.6 respond instantly.
          maxTokens: config.thinking?.enabled ? 8_192 : 2_048,
          signal: options.signal,
          thinking: config.thinking,
        },
        (token) => {
          // Heuristic: <think>… markers and reasoning_content tokens flow
          // through onToken. Surface activity in the spinner so the screen
          // is never empty for minutes.
          if (!sawReasoning && /<think|<\/think>/i.test(token)) {
            sawReasoning = true;
            spinner.setLabel("thinking");
          }
          // Show the model's actual reasoning text live. The provider
          // wraps reasoning_content in <think>…</think> in our http layer,
          // so anything between those tags is fair game for the preview.
          // For non-reasoning tokens (the eventual answer / tool call),
          // also surface them so users see the live response forming.
          spinner.pushPreview(token.replace(/<\/?think[^>]*>/gi, ""));
          const approx = token.split(/\s+/).filter(Boolean).length;
          if (approx > 0) spinner.bumpReasoning(approx);
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
    const call = parseToolCall(assistantText.visible);
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
      updateLastToolSummary(cleaned);
      if (hasToolOutputSnapshot()) {
        process.stdout.write(`${renderToolOutputHint()}\n`);
      }
      if (assistantText.hasThinking) {
        process.stdout.write(`${renderThinkingSummary(assistantText.thinkContent)}\n`);
      }
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = cleaned;
      return lastAnswer;
    }

    // Print only non-thinking text before the tool call, not raw <think> blocks.
    const beforeTool = textBeforeToolCall(assistantText.visible);
    if (beforeTool) {
      process.stdout.write(chalk.dim(renderMarkdown(beforeTool)) + "\n");
    }
    if (assistantText.hasThinking) {
      process.stdout.write(`${renderThinkingSummary(assistantText.thinkContent)}\n`);
    }

    messages.push({ role: "assistant", content: assistantText.visible });
    const decision = classifyToolCall(call);
    await auditLog("tool.classified", { call, decision });

    // Show tool call
    process.stdout.write(chalk.cyan(`  ▶ ${call.name}`) + chalk.gray(` ${formatToolArgs(call)}`) + "\n");

    if (decision.level === "block") {
      process.stdout.write(chalk.red(`  ✗ blocked: ${decision.reason}`) + "\n");
      lastAnswer = `Blocked: ${call.name} — ${decision.reason}`;
      return lastAnswer;
    }

    // Pentest authorization — if user confirms this, skip the per-tool confirm
    let pentestJustConfirmed = false;
    const needsPentestAuth = isPentestToolCall(call) && !getConfig().pentestAuthorized;
    const authorized = await ensurePentestAuthorization(
      call,
      Boolean(options.autoConfirm),
    );
    if (!authorized) {
      lastAnswer = "Pentest authorization not confirmed.";
      process.stdout.write(chalk.red(`  ✗ ${lastAnswer}`) + "\n");
      return lastAnswer;
    }
    if (needsPentestAuth) {
      pentestJustConfirmed = true;
    }

    // Confirm if needed (safe tools auto-execute, pentest-auth'd tools skip)
    if (decision.level === "confirm" && !pentestJustConfirmed) {
      const ok = await confirmToolExecution(call, Boolean(options.autoConfirm));
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
    const livePane = createToolLivePane(formatToolArgs(call));
    const printLive = (chunk: string): void => {
      // Suppress live preview for fs.read / fs.list — those are read-only
      // and the final summary is already concise. Stream shell-style tools
      // (shell.exec, net.scan, pentest.recon, pkg.install).
      if (call.name === "fs.read" || call.name === "fs.list" || call.name === "fs.search") return;
      if (liveBytes >= liveCap) {
        if (!liveTruncatedNotified) {
          liveTruncatedNotified = true;
          process.stdout.write(chalk.dim("\n  … live preview truncated, full output saved\n"));
        }
        return;
      }
      const remaining = liveCap - liveBytes;
      const slice = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
      liveBytes += slice.length;
      livePane.append(slice);
    };

    try {
      result = await runToolCall(call, {
        signal: options.signal,
        onOutput: (chunk) => {
          if (options.signal?.aborted) return;
          printLive(chunk);
        },
      });
      // Newline separator if live output didn't already end with one.
      livePane.finish();
    } catch (toolError) {
      livePane.finish();
      if (isAbortError(toolError, options.signal)) {
        lastAnswer = "Aborted.";
        process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
        return lastAnswer;
      }
      const errMsg = toolError instanceof Error ? toolError.message : String(toolError);
      result = { ok: false, output: `Tool error: ${errMsg}`, exitCode: 1 };
    }
    const output = result.output.trim();
    const displayMax = 6_000;
    const savedOutputPath = result.outputPath ?? (output.length > displayMax
      ? await saveToolOutput(call, output)
      : undefined);
    const resultWithArtifact: ToolResult = {
      ...result,
      outputPath: savedOutputPath,
      truncated: result.truncated || Boolean(savedOutputPath),
      artifacts: result.artifacts ?? (savedOutputPath
        ? [{ path: savedOutputPath, kind: "raw", redacted: true }]
        : undefined),
    };
    if (output || savedOutputPath) {
      rememberToolOutput({
        id: `${Date.now()}-${step}`,
        label: `${call.name} ${formatToolArgs(call)}`.trim(),
        artifactPath: savedOutputPath,
        fullText: savedOutputPath ? undefined : output,
        summary: result.summary ?? result.modelContext,
      });
    }
    options.onToolResult?.(call, resultWithArtifact);
    await auditLog("tool.result", {
      call,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output.slice(0, 4_000),
    });

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
      if (liveBytes > 0 && process.stdout.isTTY) {
        if (savedOutputPath) {
          process.stdout.write(chalk.dim(`  full output saved to ${savedOutputPath}\n`));
        }
      } else {
        process.stdout.write(chalk.gray(displayText) + "\n");
      }
    }
    if (isAbortError(undefined, options.signal)) {
      lastAnswer = "Aborted.";
      process.stdout.write(chalk.yellow("  ⏹ Aborted.\n"));
      return lastAnswer;
    }

    const contextOutput = formatToolContext(resultWithArtifact);
    messages.push({
      role: "tool",
      content: `Tool ${call.name} result (exit=${result.exitCode ?? 0}, ok=${result.ok}):\n${contextOutput}`,
    });
  }

  lastAnswer = `Stopped after ${maxSteps} steps.`;
  process.stdout.write(chalk.yellow(lastAnswer) + "\n");
  return lastAnswer;
}
