import { extractReasoningSummary } from "../responses-parse.js";
import { noteReasoningItem } from "../responses-stream-accumulator.js";
import type { StreamEventContext } from "../responses-stream-accumulator.js";
import { applyFunctionCallDoneFields } from "../responses-stream-events.js";
import { fromWireName } from "../tool-protocol.js";

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

export function handleOutputItemAdded(
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
  const canonical = name ? (fromWireName(name) ?? name) : undefined;
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

export function handleOutputItemDone(
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
