import type {
  CompletionRequest,
  CompletionResult,
  NativeToolCall,
} from "../types.js";
import { ProviderError } from "./http.js";
import { fromWireName } from "./tool-protocol.js";
import { emitStreamReasoningDelta } from "./stream-events.js";
import type { ResponsesDialectConfig } from "./responses-config.js";
import {
  collectDoneToolCalls,
  extractReasoningSummary,
  parseResponsesUsage,
} from "./responses-parse.js";
import type { ToolCallAccumulator } from "./responses-parse.js";
import { responsesPrivateReasoningNote } from "./responses-http.js";
import {
  absorbResponseOutput,
  noteReasoningItem,
  streamReasoningReplay,
  streamUsageResult,
} from "./responses-stream-accumulator.js";
import type { StreamEventContext } from "./responses-stream-accumulator.js";

function resolveAddedItemId(
  item: Record<string, unknown>,
  parsed: Record<string, unknown>,
): string | undefined {
  if (typeof item.id === "string") return item.id;
  if (typeof parsed.item_id === "string") return parsed.item_id;
  return undefined;
}

function handleReasoningItemAdded(
  ctx: StreamEventContext,
  item: Record<string, unknown>,
  outputIndex: number | undefined,
): void {
  noteReasoningItem(ctx.state, item, outputIndex);
  const s = extractReasoningSummary(item);
  if (s) {
    ctx.watchdog.resetIdleTimer();
    ctx.emitReasoningDelta(s);
  }
}

function handleOutputItemAdded(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const item = parsed.item as Record<string, unknown> | undefined;
  if (!item) return;
  const outputIndex =
    typeof parsed.output_index === "number" ? parsed.output_index : undefined;
  const itemId = resolveAddedItemId(item, parsed);
  if (outputIndex !== undefined && itemId) {
    ctx.state.outputIndexToItemId.set(outputIndex, itemId);
  }
  if (item.type === "function_call") {
    registerFunctionCallItem(ctx, item, outputIndex, itemId);
  } else if (item.type === "reasoning") {
    handleReasoningItemAdded(ctx, item, outputIndex);
  } else if (item.type === "message") {
    ctx.watchdog.resetIdleTimer();
  }
}

function resolveFunctionCallId(
  item: Record<string, unknown>,
  itemId: string | undefined,
  size: number,
): string {
  if (typeof item.id === "string") return item.id;
  if (typeof item.call_id === "string") return item.call_id;
  return itemId ?? `call_${size}`;
}

function emitToolCallStarted(
  ctx: StreamEventContext,
  index: number,
  callId: string | undefined,
  name: string,
  argumentsBytes: number,
): void {
  if (!ctx.request.onToolCallDelta) return;
  const canonical = name ? fromWireName(name) ?? name : undefined;
  ctx.request.onToolCallDelta({
    index,
    ...(callId ? { id: callId } : {}),
    ...(canonical ? { name: canonical } : {}),
    argumentsBytes,
  });
}

function registerFunctionCallItem(
  ctx: StreamEventContext,
  item: Record<string, unknown>,
  outputIndex: number | undefined,
  itemId: string | undefined,
): void {
  const id = resolveFunctionCallId(item, itemId, ctx.state.toolCallState.size);
  const callId = typeof item.call_id === "string" ? item.call_id : id;
  const name = typeof item.name === "string" ? item.name : "";
  const args = typeof item.arguments === "string" ? item.arguments : "";
  const toolCallIndex = ctx.state.toolCallState.size;
  ctx.state.toolCallState.set(id, { id, callId, name, arguments: args });
  if (outputIndex !== undefined) {
    ctx.state.outputIndexToToolCallIndex.set(outputIndex, toolCallIndex);
  }
  ctx.watchdog.resetIdleTimer();
  emitToolCallStarted(
    ctx,
    ctx.state.toolCallState.size - 1,
    callId,
    name,
    args.length,
  );
}

function handleOutputItemDone(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const item = parsed.item as Record<string, unknown> | undefined;
  if (item?.type === "reasoning") {
    noteReasoningItem(
      ctx.state,
      item,
      typeof parsed.output_index === "number" ? parsed.output_index : undefined,
    );
  }
  if (item?.type === "function_call") {
    mergeFunctionCallDone(ctx, parsed, item);
    ctx.watchdog.resetIdleTimer();
  }
  if (item && typeof item.status === "string") {
    ctx.state.finishReason = item.status as string;
  }
}

function applyFunctionCallDoneFields(
  state: ToolCallAccumulator,
  item: Record<string, unknown>,
): void {
  if (
    typeof item.arguments === "string" &&
    item.arguments.length > state.arguments.length
  ) {
    state.arguments = item.arguments as string;
  }
  if (typeof item.name === "string" && !state.name) state.name = item.name as string;
  if (typeof item.call_id === "string" && !state.callId) {
    state.callId = item.call_id as string;
  }
}

function mergeFunctionCallDone(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
  item: Record<string, unknown>,
): void {
  const id =
    typeof item.id === "string"
      ? item.id
      : typeof parsed.item_id === "string"
        ? (parsed.item_id as string)
        : undefined;
  if (!id || !ctx.state.toolCallState.has(id)) return;
  applyFunctionCallDoneFields(ctx.state.toolCallState.get(id)!, item);
}

function handleFunctionArgsDelta(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const delta = typeof parsed.delta === "string" ? parsed.delta : "";
  const targetId = resolveFunctionArgsTarget(ctx, parsed);
  if (targetId) {
    applyFunctionArgsDelta(ctx, targetId, delta);
    return;
  }
  if (delta) {
    const anyKey = [...ctx.state.toolCallState.keys()].pop();
    if (anyKey) {
      ctx.state.toolCallState.get(anyKey)!.arguments += delta;
      ctx.watchdog.resetIdleTimer();
    }
  }
}

function resolveFunctionArgsTarget(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): string | undefined {
  const itemId =
    typeof parsed.item_id === "string"
      ? parsed.item_id
      : typeof parsed.itemId === "string"
        ? parsed.itemId
        : undefined;
  if (itemId) return itemId;
  if (typeof parsed.output_index === "number") {
    return ctx.state.outputIndexToItemId.get(parsed.output_index);
  }
  return undefined;
}

function applyFunctionArgsDelta(
  ctx: StreamEventContext,
  targetId: string,
  delta: string,
): void {
  const state = ctx.state.toolCallState.get(targetId);
  if (!state) {
    ctx.state.toolCallState.set(targetId, {
      id: targetId,
      callId: targetId,
      name: "",
      arguments: delta,
    });
    ctx.watchdog.resetIdleTimer();
    return;
  }
  state.arguments += delta;
  ctx.watchdog.resetIdleTimer();
  if (ctx.request.onToolCallDelta) {
    const canonical = state.name ? fromWireName(state.name) ?? state.name : undefined;
    ctx.request.onToolCallDelta({
      index: [...ctx.state.toolCallState.keys()].indexOf(targetId),
      ...(state.callId ? { id: state.callId } : {}),
      ...(canonical ? { name: canonical } : {}),
      argumentsBytes: state.arguments.length,
    });
  }
}

function resolveArgsDoneTarget(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): string | undefined {
  if (typeof parsed.item_id === "string") return parsed.item_id;
  if (typeof parsed.output_index === "number") {
    return ctx.state.outputIndexToItemId.get(parsed.output_index);
  }
  return undefined;
}

function assignArgsDone(
  ctx: StreamEventContext,
  targetId: string | undefined,
  args: string,
): void {
  if (targetId && ctx.state.toolCallState.has(targetId) && args) {
    ctx.state.toolCallState.get(targetId)!.arguments = args;
    return;
  }
  if (args && ctx.state.toolCallState.size > 0) {
    const lastKey = [...ctx.state.toolCallState.keys()].pop()!;
    if (!ctx.state.toolCallState.get(lastKey)!.arguments) {
      ctx.state.toolCallState.get(lastKey)!.arguments = args;
    }
  }
}

function handleFunctionArgsDone(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const args =
    typeof parsed.arguments === "string"
      ? parsed.arguments
      : typeof parsed.argument === "string"
        ? parsed.argument
        : "";
  assignArgsDone(ctx, resolveArgsDoneTarget(ctx, parsed), args);
  ctx.watchdog.resetIdleTimer();
}

function handleResponseCompleted(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  ctx.state.sawTerminalProof = "response-completed";
  const resp = (parsed.response ?? parsed) as Record<string, unknown>;
  if (resp.usage) {
    const u = parseResponsesUsage(resp.usage);
    if (u) ctx.state.streamUsage = u;
  }
  if (typeof resp.status === "string") ctx.state.finishReason = resp.status as string;
  absorbResponseOutput(ctx.state, resp, ctx.emitVisible, ctx.emitReasoningDelta);
}

function handleResponseIncomplete(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const resp = (parsed.response ?? parsed) as Record<string, unknown>;
  const details = resp.incomplete_details as Record<string, unknown> | undefined;
  const reason = typeof details?.reason === "string" ? details.reason : "";
  if (resp.usage) {
    const u = parseResponsesUsage(resp.usage);
    if (u) ctx.state.streamUsage = u;
  }
  absorbResponseOutput(ctx.state, resp, ctx.emitVisible, ctx.emitReasoningDelta);
  ctx.state.finishReason = reason === "max_output_tokens" ? "length" : "incomplete";
  ctx.state.sawTerminalProof = "response-incomplete";
}

function throwStreamPayloadError(
  config: ResponsesDialectConfig,
  errorLike: unknown,
  payload: string,
): never {
  const rawDetail =
    typeof errorLike === "string"
      ? errorLike
      : ((errorLike as Record<string, unknown>).message as string | undefined) ??
        ((errorLike as Record<string, unknown>).type as string | undefined) ??
        "unknown error";
  const detail =
    rawDetail.trim().length <= 2 ? `${rawDetail} — ${payload.slice(0, 300)}` : rawDetail;
  throw new ProviderError(
    `${config.displayName} stream error: ${detail}`,
    undefined,
    payload.slice(0, 1000),
  );
}

function throwFailedResponseError(
  config: ResponsesDialectConfig,
  resp: Record<string, unknown>,
  type: string,
  payload: string,
): never {
  const err = resp.error as Record<string, unknown> | undefined;
  const rawDetail = err?.message ?? err?.code ?? type;
  const rawStr = String(rawDetail);
  const detail =
    rawStr.trim().length <= 2 ? `${rawStr} — ${payload.slice(0, 300)}` : rawStr;
  throw new ProviderError(
    `${config.displayName} stream error: ${detail}`,
    undefined,
    payload.slice(0, 1000),
  );
}

function dispatchLifecycleEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
): boolean {
  if (type === "response.created" || type === "response.in_progress") {
    const resp = (parsed.response ?? parsed) as Record<string, unknown>;
    if (typeof resp.id === "string") ctx.state.responseId = resp.id;
    return true;
  }
  if (
    type === "response.content_part.added" ||
    type === "response.content_part.done"
  ) {
    return true;
  }
  return false;
}

function dispatchItemEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
): boolean {
  if (type === "response.output_item.added") {
    handleOutputItemAdded(ctx, parsed);
    return true;
  }
  if (type === "response.output_item.done") {
    handleOutputItemDone(ctx, parsed);
    return true;
  }
  return false;
}

function dispatchContentDeltaEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
): boolean {
  if (type === "response.output_text.delta") {
    const delta = typeof parsed.delta === "string" ? parsed.delta : "";
    if (delta) {
      ctx.watchdog.resetIdleTimer();
      ctx.emitVisible(delta);
    }
    return true;
  }
  return dispatchReasoningEvent(ctx, type, parsed);
}

function dispatchToolEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
): boolean {
  if (type === "response.function_call_arguments.delta") {
    handleFunctionArgsDelta(ctx, parsed);
    return true;
  }
  if (type === "response.function_call_arguments.done") {
    handleFunctionArgsDone(ctx, parsed);
    return true;
  }
  return false;
}

function dispatchTerminalEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
  payload: string,
): boolean {
  if (type === "response.completed") {
    handleResponseCompleted(ctx, parsed);
    return true;
  }
  if (type === "response.failed" || type === "response.incomplete") {
    if (type === "response.incomplete") {
      handleResponseIncomplete(ctx, parsed);
      return true;
    }
    const resp = (parsed.response ?? parsed) as Record<string, unknown>;
    throwFailedResponseError(ctx.config, resp, type, payload);
  }
  return false;
}

export function dispatchStreamEvent(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
  payload: string,
): void {
  if (parsed.error) {
    throwStreamPayloadError(ctx.config, parsed.error, payload);
  }
  const type = parsed.type as string | undefined;
  if (dispatchLifecycleEvent(ctx, type, parsed)) return;
  if (dispatchItemEvent(ctx, type, parsed)) return;
  if (dispatchContentDeltaEvent(ctx, type, parsed)) return;
  if (dispatchToolEvent(ctx, type, parsed)) return;
  if (dispatchTerminalEvent(ctx, type, parsed, payload)) return;
  absorbTrailingUsage(ctx, parsed);
}

function dispatchReasoningEvent(
  ctx: StreamEventContext,
  type: string | undefined,
  parsed: Record<string, unknown>,
): boolean {
  if (type === "response.reasoning_summary_text.delta") {
    const delta = typeof parsed.delta === "string" ? parsed.delta : "";
    if (delta) {
      ctx.watchdog.resetIdleTimer();
      ctx.emitReasoningDelta(delta);
    }
    return true;
  }
  if (type === "response.reasoning_summary_text.done") {
    const textVal = typeof parsed.text === "string" ? parsed.text : "";
    if (textVal && !ctx.state.reasoningSeen.includes(textVal)) {
      const remaining = textVal.slice(ctx.state.reasoningSeen.length);
      if (remaining) {
        ctx.watchdog.resetIdleTimer();
        ctx.emitReasoningDelta(remaining);
      }
    }
    return true;
  }
  return false;
}

function absorbTrailingUsage(
  ctx: StreamEventContext,
  parsed: Record<string, unknown>,
): void {
  const usageField = parsed.usage;
  if (usageField) {
    const u = parseResponsesUsage(usageField);
    if (u) {
      ctx.state.streamUsage = u;
      ctx.watchdog.resetIdleTimer();
    }
  }
  if (parsed.choices) {
    const chunkUsage = parseResponsesUsage(parsed.usage);
    if (chunkUsage) ctx.state.streamUsage = chunkUsage;
  }
}

export function finalizeStreamResult(
  ctx: StreamEventContext,
  toolCalls: NativeToolCall[],
): CompletionResult {
  const { config, model, state, request } = ctx;
  if (!state.visible.trim() && toolCalls.length === 0) {
    if (state.reasoningSeen.trim() || state.finishReason === "length") {
      return {
        text: state.full,
        provider: config.providerId,
        model,
        finishReason: state.finishReason ?? "stop",
        ...streamUsageResult(state),
        ...streamReasoningReplay(config, model, state, request.onStreamEvent),
      };
    }
    throw new ProviderError(
      `${config.displayName} completed without a visible answer.`,
    );
  }
  return {
    text: state.full,
    provider: config.providerId,
    model,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(state.finishReason
      ? { finishReason: state.finishReason }
      : toolCalls.length
        ? { finishReason: "tool_calls" }
        : {}),
    ...streamUsageResult(state),
    ...streamReasoningReplay(config, model, state, request.onStreamEvent),
  };
}

export function maybeAppendPrivateReasoning(ctx: StreamEventContext): void {
  const { state, config, request } = ctx;
  if (
    !state.reasoningSeen.trim() &&
    state.streamUsage?.reasoningTokens &&
    state.streamUsage.reasoningTokens > 0 &&
    (state.visible.trim() || state.toolCallState.size > 0)
  ) {
    const note = responsesPrivateReasoningNote(
      config,
      request,
      state.streamUsage.reasoningTokens,
    );
    state.reasoningSeen += note;
    emitStreamReasoningDelta(request.onStreamEvent, note);
  }
}

export function processStreamPayload(
  ctx: StreamEventContext,
  payload: string,
): CompletionResult | undefined {
  if (payload === "[DONE]") {
    maybeAppendPrivateReasoning(ctx);
    return finalizeStreamResult(ctx, collectDoneToolCalls(ctx.state.toolCallState));
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  dispatchStreamEvent(ctx, parsed, payload);
  return undefined;
}
