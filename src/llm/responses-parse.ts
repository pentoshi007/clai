import type { CompletionResult, NativeToolCall } from "../types.js";
import { fromWireName, parseToolArguments } from "./tool-protocol.js";
import { normalizeTokenUsage } from "./token-usage.js";
import type { TokenUsage } from "./token-usage.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "./reasoning-artifacts.js";
import type { ResponsesDialectConfig } from "./responses-config.js";

export interface ToolCallAccumulator {
  id?: string;
  name?: string;
  arguments: string;
  callId?: string;
}

export interface ResponsesReasoningItemPosition {
  readonly sequence: number;
  readonly toolCallIndex?: number | undefined;
}

export interface ParsedResponsesOutput {
  text: string;
  toolCalls: NativeToolCall[];
  usage?: TokenUsage | undefined;
  reasoningSummary: string;
  reasoningItems: Array<Record<string, unknown>>;
  reasoningItemPositions: ResponsesReasoningItemPosition[];
}

export function parseResponsesUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens =
    (u.input_tokens as number | undefined) ??
    (u.prompt_tokens as number | undefined) ??
    (u.inputTokens as number | undefined);
  const outputTokens =
    (u.output_tokens as number | undefined) ??
    (u.completion_tokens as number | undefined) ??
    (u.outputTokens as number | undefined);
  const totalTokens =
    (u.total_tokens as number | undefined) ??
    (u.totalTokens as number | undefined);
  const inputDetails = u.input_tokens_details as
    Record<string, unknown> | undefined;
  const promptDetails = u.prompt_tokens_details as
    Record<string, unknown> | undefined;
  const outputDetails = u.output_tokens_details as
    Record<string, unknown> | undefined;
  const completionDetails = u.completion_tokens_details as
    Record<string, unknown> | undefined;
  const cached = inputDetails?.cached_tokens ?? promptDetails?.cached_tokens;
  const cacheCreation =
    inputDetails?.cache_creation_tokens ??
    promptDetails?.cache_creation_tokens ??
    u.cache_creation_input_tokens;
  const uncached =
    inputDetails?.uncached_tokens ??
    promptDetails?.uncached_tokens ??
    u.prompt_cache_miss_tokens;
  const reasoning =
    outputDetails?.reasoning_tokens ?? completionDetails?.reasoning_tokens;
  return normalizeTokenUsage({
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    cachedPromptTokens: typeof cached === "number" ? cached : undefined,
    cacheCreationTokens:
      typeof cacheCreation === "number" ? cacheCreation : undefined,
    uncachedPromptTokens: typeof uncached === "number" ? uncached : undefined,
    reasoningTokens: typeof reasoning === "number" ? reasoning : undefined,
    exact: true,
  });
}

function extractReasoningSummary(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const obj = item as Record<string, unknown>;
  const summary = obj.summary;
  if (!Array.isArray(summary)) return "";
  let out = "";
  for (const s of summary) {
    if (
      s &&
      typeof s === "object" &&
      typeof (s as Record<string, unknown>).text === "string"
    ) {
      out += (s as Record<string, unknown>).text as string;
    }
  }
  return out;
}

function parseStreamToolArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return parseToolArguments(raw);
  }
}

function parseResponsesFunctionCall(
  obj: Record<string, unknown>,
  index: number,
): NativeToolCall {
  const callId =
    typeof obj.call_id === "string"
      ? obj.call_id
      : typeof obj.id === "string"
        ? obj.id
        : `call_${index}`;
  const nameWire = typeof obj.name === "string" ? obj.name : "";
  const canonical = fromWireName(nameWire) ?? nameWire;
  const rawArgs =
    typeof obj.arguments === "string"
      ? obj.arguments
      : JSON.stringify(obj.arguments ?? {});
  return {
    id: callId,
    name: canonical,
    args: parseStreamToolArgs(rawArgs),
    rawArguments: rawArgs,
  };
}

function appendAssistantMessageText(
  obj: Record<string, unknown>,
  current: string,
): string {
  const content = obj.content;
  if (!Array.isArray(content)) return current;
  let text = current;
  for (const block of content) {
    if (block && typeof block === "object") {
      const b = block as Record<string, unknown>;
      if (b.type === "output_text" && typeof b.text === "string") {
        text += b.text as string;
      }
    }
  }
  return text;
}

export function parseResponsesOutput(data: {
  output?: unknown;
  usage?: unknown;
  id?: string;
}): ParsedResponsesOutput {
  const output = Array.isArray(data.output) ? data.output : [];
  let text = "";
  let reasoningSummary = "";
  const toolCalls: NativeToolCall[] = [];
  const reasoningItems: Array<Record<string, unknown>> = [];
  const reasoningItemSequences: number[] = [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> =
    [];
  for (const [sequence, item] of output.entries()) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "message" && obj.role === "assistant") {
      text = appendAssistantMessageText(obj, text);
    } else if (obj.type === "reasoning") {
      const s = extractReasoningSummary(obj);
      if (s) reasoningSummary += s;
      if (typeof obj.encrypted_content === "string" && obj.encrypted_content) {
        reasoningItems.push({ ...obj });
        reasoningItemSequences.push(sequence);
      }
    } else if (obj.type === "function_call") {
      toolCallSequences.push({ sequence, toolCallIndex: toolCalls.length });
      toolCalls.push(parseResponsesFunctionCall(obj, toolCalls.length));
    }
  }
  const reasoningItemPositions = reasoningItemSequences.map((sequence) => {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > sequence,
    );
    return followingTool
      ? { sequence, toolCallIndex: followingTool.toolCallIndex }
      : { sequence };
  });
  return {
    text,
    toolCalls,
    usage: parseResponsesUsage(data.usage),
    reasoningSummary,
    reasoningItems,
    reasoningItemPositions,
  };
}

export function responsesReasoningArtifacts(
  config: ResponsesDialectConfig,
  model: string,
  items: readonly Record<string, unknown>[],
  positions: readonly ResponsesReasoningItemPosition[],
) {
  const provenance = createReasoningArtifactProvenance({
    provider: config.providerId,
    model,
    dialect: config.artifactDialect,
    endpoint: config.baseUrl,
  });
  const artifacts = items.map((item, index) => {
    const position = positions[index] ?? { sequence: index };
    const replayable = position.toolCallIndex !== undefined;
    return createReasoningArtifact({
      kind: "encrypted",
      raw: item,
      provenance,
      replay: replayable
        ? { scope: "tool-turn", persistence: "tool-turn" }
        : { scope: "none", persistence: "never" },
      position: {
        sequence: position.sequence,
        placement: replayable ? "before-tool-call" : "assistant",
        ...(replayable ? { toolCallIndex: position.toolCallIndex } : {}),
      },
    });
  });
  return artifacts.length ? artifacts : undefined;
}

export function collectDoneToolCalls(
  toolCallState: Map<string, ToolCallAccumulator>,
): NativeToolCall[] {
  const toolCalls: NativeToolCall[] = [];
  for (const [, state] of toolCallState) {
    if (!state.name) continue;
    const canonical = state.name
      ? (fromWireName(state.name) ?? state.name)
      : (state.name ?? "");
    const raw = state.arguments;
    toolCalls.push({
      id: state.callId ?? state.id ?? `call_${toolCalls.length}`,
      name: canonical,
      args: parseStreamToolArgs(raw),
      rawArguments: raw,
    });
  }
  return toolCalls;
}

export function collectEofToolCalls(
  toolCallState: Map<string, ToolCallAccumulator>,
): NativeToolCall[] {
  const toolCalls: NativeToolCall[] = [];
  for (const [, state] of toolCallState) {
    if (!state.name && !state.arguments) continue;
    const name = state.name || "";
    const canonical = name ? (fromWireName(name) ?? name) : "";
    if (!canonical) continue;
    const raw = state.arguments;
    toolCalls.push({
      id: state.callId ?? state.id ?? `call_${toolCalls.length}`,
      name: canonical,
      args: parseStreamToolArgs(raw || "{}"),
      rawArguments: raw,
    });
  }
  return toolCalls;
}

function completionFinishReason(
  parsed: ParsedResponsesOutput,
  outputBudgetIncomplete: boolean,
): "tool_calls" | "length" | "stop" {
  if (parsed.toolCalls.length) return "tool_calls";
  return outputBudgetIncomplete ? "length" : "stop";
}

function reasoningResultFields(
  parsed: ParsedResponsesOutput,
): Record<string, unknown> {
  if (parsed.reasoningItems.length) {
    return {
      reasoningBlock: {
        text: parsed.reasoningSummary,
        items: parsed.reasoningItems,
      },
    };
  }
  if (parsed.reasoningSummary) {
    return { reasoningBlock: { text: parsed.reasoningSummary } };
  }
  return {};
}

export function isOutputBudgetIncomplete(
  data: Record<string, unknown>,
): boolean {
  const details = data.incomplete_details as
    Record<string, unknown> | undefined;
  return (
    data.status === "incomplete" && details?.reason === "max_output_tokens"
  );
}

export interface CompletionAssembly {
  config: ResponsesDialectConfig;
  model: string;
  parsed: ParsedResponsesOutput;
  usage: TokenUsage | undefined;
  reasoningArtifacts: ReturnType<typeof responsesReasoningArtifacts>;
  outputBudgetIncomplete: boolean;
}

export function assembleCompletionResult(
  input: CompletionAssembly,
): CompletionResult {
  const {
    config,
    model,
    parsed,
    usage,
    reasoningArtifacts,
    outputBudgetIncomplete,
  } = input;
  const api = config.providerId === "meta" ? "meta-responses" : "responses";
  return {
    text: parsed.text,
    provider: config.providerId,
    model,
    api,
    ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
    finishReason: completionFinishReason(parsed, outputBudgetIncomplete),
    ...(usage ? { usage } : {}),
    ...reasoningResultFields(parsed),
    ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
  };
}

export function assembleCompletionResultWithThinking(
  input: CompletionAssembly & { thinkingEnabled?: boolean | undefined },
): CompletionResult {
  const base = assembleCompletionResult(input);
  if (input.thinkingEnabled === false) {
    const { reasoningBlock: _rb, reasoningArtifacts: _ra, ...rest } = base as unknown as Record<string, unknown>;
    return rest as unknown as CompletionResult;
  }
  return base;
}

export { extractReasoningSummary };
