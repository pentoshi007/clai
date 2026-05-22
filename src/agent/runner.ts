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
import { getConfig, updateConfig } from "../store/config.js";
import { classifyToolCall, isPentestToolCall } from "../safety/classifier.js";
import { availableToolNames, runToolCall } from "../tools/registry.js";
import { auditLog } from "../store/logs.js";
import { loadProjectContext } from "../store/project.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { rememberThinkingFromText, renderThinkingSummary } from "../ui/thinking.js";

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

export function parseToolCall(text: string): ToolCall | undefined {
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

  // 3. ### tool / ## tool / # tool heading + JSON
  const heading = text.match(/#{1,3}\s*tool\s*\n\s*(\{[\s\S]*\})/i);
  if (heading?.[1]) {
    const call = tryParseCall(heading[1]);
    if (call) return call;
  }

  // 4. **tool** heading + JSON
  const bold = text.match(/\*\*tool\*\*\s*\n\s*(\{[\s\S]*\})/i);
  if (bold?.[1]) {
    const call = tryParseCall(bold[1]);
    if (call) return call;
  }

  // 5. Any fenced block (```json, ```, etc.) containing name+args
  const anyFenced = text.match(/```\w*\s*\n?([\s\S]*?)```/);
  if (anyFenced?.[1]) {
    const call = tryParseCall(anyFenced[1]);
    if (call) return call;
  }

  // 6. Trailing JSON object with "name" and "args"
  const trailingJson = text.match(/(\{"name"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[\s\S]*?\}\s*\})\s*$/);
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

function safeArtifactName(name: string): string {
  return name.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "") || "tool-output";
}

async function saveToolOutput(call: ToolCall, output: string): Promise<string | undefined> {
  if (!output.trim()) return undefined;
  const dir = join(homedir(), ".clai", "outputs");
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(dir, `${stamp}-${safeArtifactName(call.name)}.txt`);
  await writeFile(path, `${output}\n`, "utf8");
  return path;
}

function summarizeOutput(output: string, maxChars = 8_000): { text: string; truncated: boolean } {
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

function formatToolContext(result: ToolResult): string {
  const output = result.output.trim();
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
    updateConfig({ pentestAuthorized: true });
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

  for (let step = 0; step < maxSteps; step += 1) {
    options.signal?.throwIfAborted();
    // Buffer LLM output so tool JSON and hidden thinking are not printed raw.
    const completion = await streamWithProvider(
      {
        provider,
        model,
        messages,
        temperature: 0.2,
        maxTokens: 4_096,
        signal: options.signal,
      },
      () => {},
    );
    provider = completion.provider;
    model = completion.model;

    const assistantText = rememberThinkingFromText(completion.text);
    const call = parseToolCall(assistantText.visible);
    if (!call) {
      if (assistantText.visible) {
        process.stdout.write(assistantText.visible);
        if (!assistantText.visible.endsWith("\n")) process.stdout.write("\n");
      }
      if (assistantText.hasThinking) {
        process.stdout.write(`${renderThinkingSummary(assistantText.thinkContent)}\n`);
      }
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = assistantText.visible;
      return lastAnswer;
    }

    // Print only non-thinking text before the tool call, not raw <think> blocks.
    const beforeTool = textBeforeToolCall(assistantText.visible);
    if (beforeTool) {
      process.stdout.write(chalk.dim(beforeTool) + "\n");
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
    try {
      result = await runToolCall(call, { signal: options.signal });
    } catch (toolError) {
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
    const savedOutputPath = output.length > displayMax
      ? await saveToolOutput(call, output)
      : undefined;
    const resultWithArtifact: ToolResult = {
      ...result,
      outputPath: savedOutputPath,
      truncated: Boolean(savedOutputPath),
    };
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
      process.stdout.write(chalk.gray(displayText) + "\n");
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
