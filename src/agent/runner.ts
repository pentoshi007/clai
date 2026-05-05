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

export interface AgentRunOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  autoConfirm?: boolean | undefined;
  maxSteps?: number | undefined;
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
  if (call.name === "net.scan") return `${call.args.target ?? ""}${call.args.ports ? ` -p ${call.args.ports}` : ""}`;
  if (call.name === "pentest.recon") return String(call.args.target ?? "");
  if (call.name === "fs.read" || call.name === "fs.write") return String(call.args.path ?? "");
  if (call.name === "fs.search") return String(call.args.pattern ?? "");
  if (call.name === "http.fetch") return String(call.args.url ?? "");
  if (call.name === "pkg.install") return String(call.args.tool ?? "");
  if (call.name === "fs.list") return String(call.args.path ?? process.cwd());
  return JSON.stringify(call.args);
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
  const maxSteps = options.maxSteps ?? 25;
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
    // Stream LLM response to stdout
    let streamed = false;
    const completion = await streamWithProvider(
      {
        provider,
        model,
        messages,
        temperature: 0.2,
        maxTokens: 2_000,
      },
      (token) => {
        // Buffer — we'll print selectively after we have the full response
        // For now, don't stream directly since we need to strip tool call JSON
        streamed = true;
      },
    );
    provider = completion.provider;
    model = completion.model;

    const call = parseToolCall(completion.text);
    if (!call) {
      // Final answer — print it
      process.stdout.write(completion.text);
      process.stdout.write("\n");
      await auditLog("agent.final", { provider, model, steps: step + 1 });
      lastAnswer = completion.text;
      return lastAnswer;
    }

    // Print only the thinking text, not the raw tool call JSON
    const thinking = textBeforeToolCall(completion.text);
    if (thinking) {
      process.stdout.write(chalk.dim(thinking) + "\n");
    }

    messages.push({ role: "assistant", content: completion.text });
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
    options.onToolStart?.(call);
    const result = await runToolCall(call);
    options.onToolResult?.(call, result);
    await auditLog("tool.result", {
      call,
      ok: result.ok,
      exitCode: result.exitCode,
      output: result.output.slice(0, 4_000),
    });

    // Print tool result
    const statusIcon = result.ok ? chalk.green("  ✓") : chalk.red("  ✗");
    process.stdout.write(statusIcon + "\n");
    const output = result.output.trim();
    if (output) {
      const displayMax = 3_000;
      const displayText = output.length > displayMax
        ? output.slice(0, displayMax) + chalk.dim("\n  ... (truncated)")
        : output;
      process.stdout.write(chalk.gray(displayText) + "\n");
    }

    // Truncate output for LLM context to avoid blowing token limits
    const contextMax = 4_000;
    const contextOutput = output.length > contextMax
      ? output.slice(0, contextMax) + `\n... (output truncated — ${output.length} chars total, showing first ${contextMax})`
      : output;
    messages.push({
      role: "tool",
      content: `Tool ${call.name} result (exit=${result.exitCode ?? 0}, ok=${result.ok}):\n${contextOutput}`,
    });
  }

  lastAnswer = `Stopped after ${maxSteps} steps.`;
  process.stdout.write(chalk.yellow(lastAnswer) + "\n");
  return lastAnswer;
}
