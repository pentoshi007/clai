import { modelMaxOutputTokens } from "../../llm/context-windows.js";
import { OperationLedger, singleAdmissionOperationPolicy } from "../../llm/operation-ledger.js";
import { effortReasoningBudgetTokens } from "../../llm/reasoning-controls.js";
import { completeWithProvider } from "../../llm/router.js";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ProviderId,
  ReasoningPreference,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import { planCompactionReplay } from "../compaction-executor.js";
import { projectToolHistory } from "../tool-history.js";
import { canRetryWithExcerpt } from "./goal-failure.js";
import { GOAL_EVALUATOR_SYSTEM_PROMPT, goalEvaluationPrompt } from "./goal-prompts.js";
import { parseGoalVerdict, type GoalVerdict } from "./goal-verdict.js";

const VERDICT_OUTPUT_TOKENS = 1024;
const EXCERPT_OUTPUT_TOKENS = 2048;
const EXCERPT_BUDGET_CHARS = 48_000;
const USER_CLIP_CHARS = 4_000;
const CONTEXT_CLIP_CHARS = 600;
const ASSISTANT_CLIP_CHARS = 4_000;
const TOOL_CALL_CLIP_CHARS = 300;
const TOOL_RESULT_CLIP_CHARS = 1_500;

export type GoalEvaluationRoute = "replay" | "excerpt";

export interface GoalEvaluationInput {
  readonly objective: string;
  readonly history: readonly ChatMessage[];
  readonly baseRequest?: SuccessfulRequestSnapshot | undefined;
  readonly provider: ProviderId;
  readonly model: string;
  readonly thinking?: ReasoningPreference | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly signal: AbortSignal;
  readonly onUsage?: ((result: CompletionResult) => void) | undefined;
}

export interface GoalEvaluation {
  readonly verdict: GoalVerdict | undefined;
  readonly route: GoalEvaluationRoute;
}

function clip(text: string, limit: number): string {
  const flat = text.trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function replayOutputTokens(base: SuccessfulRequestSnapshot): number {
  const reasoning = base.thinking?.enabled === true ? effortReasoningBudgetTokens(base.thinking.effort) : 0;
  const wanted = VERDICT_OUTPUT_TOKENS + reasoning;
  const ceiling = modelMaxOutputTokens(base.provider, base.model);
  return ceiling === undefined ? wanted : Math.max(VERDICT_OUTPUT_TOKENS, Math.min(wanted, ceiling));
}

export function buildGoalReplayRequest(input: GoalEvaluationInput): CompletionRequest | undefined {
  const base = input.baseRequest;
  if (!base) return undefined;
  const prompt = goalEvaluationPrompt(input.objective);
  const maxTokens = replayOutputTokens(base);
  const plan = planCompactionReplay({
    baseRequest: base,
    history: projectToolHistory(input.history).messages,
    prompt,
    maxTokens,
    contextLimitTokens: input.contextLimitTokens,
    stream: false,
  });
  if (!plan || plan.accounting.overLimit) return undefined;
  const messages: ChatMessage[] = [
    ...plan.messages.slice(0, -1),
    { role: "user", content: prompt, internal: true },
  ];
  return {
    provider: base.provider,
    model: base.model,
    purpose: "evaluation",
    messages,
    maxTokens,
    ...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
    ...(base.thinking ? { thinking: structuredClone(base.thinking) } : {}),
    ...(base.forceReasoningReplay !== undefined ? { forceReasoningReplay: base.forceReasoningReplay } : {}),
    ...(base.tools ? { tools: base.tools.map((tool) => structuredClone(tool)) } : {}),
    ...(base.toolChoice !== undefined ? { toolChoice: structuredClone(base.toolChoice) } : {}),
    ...(base.parallelToolCalls !== undefined ? { parallelToolCalls: base.parallelToolCalls } : {}),
    signal: input.signal,
  };
}

function excerptLine(message: ChatMessage): string | undefined {
  if (message.role === "system") return undefined;
  if (message.role === "user") {
    return message.internal
      ? `[context] ${clip(message.content, CONTEXT_CLIP_CHARS)}`
      : `User: ${clip(message.content, USER_CLIP_CHARS)}`;
  }
  if (message.role === "tool") {
    const label = message.name ? ` ${message.name}` : "";
    const status = message.ok === false ? " (failed)" : "";
    return `Tool result${label}${status}: ${clip(message.content, TOOL_RESULT_CLIP_CHARS)}`;
  }
  const parts: string[] = [];
  if (message.content.trim()) parts.push(`Assistant: ${clip(message.content, ASSISTANT_CLIP_CHARS)}`);
  for (const call of message.toolCalls ?? []) {
    parts.push(`Assistant called ${call.name}(${clip(JSON.stringify(call.args ?? {}), TOOL_CALL_CLIP_CHARS)})`);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function buildGoalExcerpt(history: readonly ChatMessage[], budgetChars = EXCERPT_BUDGET_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  let omitted = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const line = excerptLine(history[index]!);
    if (!line) continue;
    if (used + line.length > budgetChars && lines.length > 0) {
      omitted = true;
      break;
    }
    lines.push(line);
    used += line.length + 2;
  }
  lines.reverse();
  const header = omitted
    ? "Conversation excerpt (older messages omitted, most recent last):"
    : "Conversation (most recent last):";
  return [header, "", lines.join("\n\n")].join("\n");
}

export function buildGoalExcerptRequest(input: GoalEvaluationInput): CompletionRequest {
  const history = projectToolHistory(input.history).messages;
  return {
    provider: input.provider,
    model: input.model,
    purpose: "auxiliary",
    messages: [
      { role: "system", content: GOAL_EVALUATOR_SYSTEM_PROMPT },
      { role: "user", content: `${buildGoalExcerpt(history)}\n\n${goalEvaluationPrompt(input.objective)}` },
    ],
    temperature: 0.1,
    maxTokens: EXCERPT_OUTPUT_TOKENS,
    ...(input.thinking ? { thinking: structuredClone(input.thinking) } : {}),
    signal: input.signal,
  };
}

async function complete(request: CompletionRequest, input: GoalEvaluationInput): Promise<GoalVerdict | undefined> {
  const result = await completeWithProvider(request, {
    maxRetries: 0,
    singleDispatch: true,
    operation: new OperationLedger(singleAdmissionOperationPolicy("background")),
  });
  input.onUsage?.(result);
  return parseGoalVerdict(result.text);
}

export async function evaluateGoal(input: GoalEvaluationInput): Promise<GoalEvaluation> {
  const replay = buildGoalReplayRequest(input);
  if (replay) {
    try {
      const verdict = await complete(replay, input);
      if (verdict) return { verdict, route: "replay" };
    } catch (error) {
      if (input.signal.aborted || !canRetryWithExcerpt(error)) throw error;
    }
  }
  input.signal.throwIfAborted();
  return { verdict: await complete(buildGoalExcerptRequest(input), input), route: "excerpt" };
}
