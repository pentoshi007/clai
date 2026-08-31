import type { AnyAppEvent } from "../../../app/events/app-event.js";
import { EMPTY_STRIP_STREAM, pushStripChunk } from "../../rendering/incremental-strip.js";
import type { StripStream } from "../../rendering/incremental-strip.js";
import { stripToolCallSurfaces } from "../../rendering/strip-tool-surfaces.js";
import { appendItem, moveItemBefore, removeItem, updateItem } from "../transcript-struct.js";
import type { AssistantItem, ThinkingItem, TranscriptItem, TranscriptState } from "../transcript-types.js";

export function discardPendingToolFenceStream(state: TranscriptState): TranscriptState {
  if (!state.pendingAssistantId) return state;
  const pending = state.byId.get(state.pendingAssistantId);
  if (!pending || pending.kind !== "assistant") {
    return { ...state, pendingAssistantId: undefined };
  }
  const stripped = stripToolCallSurfaces(pending.text).trim();
  if (!stripped) {
    return {
      ...clearStripStream(removeItem(state, state.pendingAssistantId), state.pendingAssistantId),
      pendingAssistantId: undefined,
    };
  }
  if (stripped === pending.text) {
    return state;
  }
  return updateItem(state, state.pendingAssistantId, (item) => ({
    ...(item as AssistantItem),
    text: stripped,
  }));
}

function isEmptyAssistantPlaceholder(
  state: TranscriptState,
  assistantId: string,
): boolean {
  const item = state.byId.get(assistantId);
  if (!item || item.kind !== "assistant") return true;
  return item.text.trim().length === 0;
}

function withStripStream(
  state: TranscriptState,
  id: string,
  stream: StripStream,
): TranscriptState {
  const streams = new Map(state.assistantStripStreams);
  streams.set(id, stream);
  return { ...state, assistantStripStreams: streams };
}

export function clearStripStream(state: TranscriptState, id: string | undefined): TranscriptState {
  if (!id || !state.assistantStripStreams.has(id)) return state;
  const streams = new Map(state.assistantStripStreams);
  streams.delete(id);
  return { ...state, assistantStripStreams: streams };
}

function joinThinkingChunks(existing: string, incoming: string): string {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.endsWith("\n\n") || incoming.startsWith("\n\n")) return existing + incoming;
  if (existing.endsWith("\n") || incoming.startsWith("\n")) return `${existing}\n${incoming}`;
  return `${existing}\n\n${incoming}`;
}

function lastAdjacentThinking(
  state: TranscriptState,
  turnId: string | undefined,
  reasoningId?: string | undefined,
): ThinkingItem | undefined {
  let index = state.order.length - 1;
  let last = index >= 0 ? state.byId.get(state.order[index]!) : undefined;
  if (
    last?.kind === "assistant" &&
    state.pendingAssistantId === last.id &&
    isEmptyAssistantPlaceholder(state, last.id)
  ) {
    index -= 1;
    last = index >= 0 ? state.byId.get(state.order[index]!) : undefined;
  }
  if (last?.kind !== "thinking" || last.turnId !== turnId) return undefined;
  if (reasoningId !== undefined && last.reasoningId !== undefined) {
    return last.reasoningId === reasoningId ? last : undefined;
  }
  return last;
}

function thinkingRowOwnedBy(
  state: TranscriptState,
  turnId: string | undefined,
  reasoningId: string,
): ThinkingItem | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.byId.get(state.order[index]!);
    if (
      item?.kind === "thinking" &&
      item.turnId === turnId &&
      item.reasoningId === reasoningId
    ) {
      return item;
    }
  }
  return undefined;
}

function finalizedThinkingContent(
  existing: string,
  final: string,
  reasoningId?: string | undefined,
): string {
  if (!final.trim()) return existing;
  if (reasoningId !== undefined) return final;
  return existing.trim().endsWith(final.trim()) ? existing : final;
}

function ownedPendingId(
  state: TranscriptState,
  kind: "assistant" | "thinking",
  reasoningId?: string | undefined,
): string | undefined {
  const pendingId =
    kind === "assistant" ? state.pendingAssistantId : state.pendingThinkingId;
  if (pendingId === undefined || kind === "assistant") return pendingId;
  if (reasoningId === undefined) return pendingId;
  const pending = state.byId.get(pendingId);
  if (pending?.kind !== "thinking" || pending.reasoningId === undefined) {
    return pendingId;
  }
  return pending.reasoningId === reasoningId ? pendingId : undefined;
}

function turnHasThinkingRow(
  state: TranscriptState,
  turnId: string | undefined,
): boolean {
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item?.kind === "thinking" && item.turnId === turnId) return true;
  }
  return false;
}

function firstAssistantIdInTurn(
  state: TranscriptState,
  turnId: string | undefined,
): string | undefined {
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item?.kind === "assistant" && item.turnId === turnId) return id;
  }
  return undefined;
}

function thinkingHoistTarget(
  state: TranscriptState,
  turnId: string | undefined,
): string | undefined {
  const pending = state.pendingAssistantId;
  if (pending && isEmptyAssistantPlaceholder(state, pending)) return pending;
  if (turnHasThinkingRow(state, turnId)) return undefined;
  return firstAssistantIdInTurn(state, turnId);
}

export function appendDelta(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
  reasoningId?: string | undefined,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const pendingId = ownedPendingId(state, kind, reasoningId);
  if (kind === "thinking" && state.pendingThinkingId && pendingId === undefined) {
    state = closePendingThinking(state, event.timestamp);
  }
  if (pendingId) {
    if (kind === "assistant") {
      const pushed = pushStripChunk(
        state.assistantStripStreams.get(pendingId) ?? EMPTY_STRIP_STREAM,
        text,
      );
      const next = updateItem(state, pendingId, (item) => ({
        ...(item as AssistantItem),
        text: pushed.text,
      }));
      return withStripStream(next, pendingId, pushed.stream);
    }
    return updateItem(state, pendingId, (item) => ({
      ...(item as ThinkingItem),
      content: (item as ThinkingItem).content + text,
      startedAt: (item as ThinkingItem).startedAt ?? item.timestamp,
      endedAt: undefined,
    }));
  }
  if (kind === "thinking") {
    const mergeTarget = lastAdjacentThinking(state, event.turnId, reasoningId);
    if (mergeTarget) {
      const reopened = updateItem(state, mergeTarget.id, (item) => ({
        ...(item as ThinkingItem),
        content: joinThinkingChunks((item as ThinkingItem).content, text),
        streaming: true,
        startedAt: (item as ThinkingItem).startedAt ?? item.timestamp,
        endedAt: undefined,
      }));
      return { ...reopened, [pendingKey]: mergeTarget.id } as TranscriptState;
    }
  }
  const id = `${kind}-${event.id}`;
  const base = {
    id,
    sequence: event.sequence,
    turnId: event.turnId,
    timestamp: event.timestamp,
  };
  if (kind === "assistant") {
    const pushed = pushStripChunk(EMPTY_STRIP_STREAM, text);
    const item: TranscriptItem = {
      ...base,
      kind: "assistant",
      text: pushed.text,
      streaming: true,
    };
    const opened = { ...appendItem(state, item), [pendingKey]: id } as TranscriptState;
    return withStripStream(opened, id, pushed.stream);
  }
  const item: TranscriptItem = {
    ...base,
    kind: "thinking",
    content: text,
    streaming: true,
    startedAt: event.timestamp,
    ...(reasoningId !== undefined ? { reasoningId } : {}),
  };
  const next: TranscriptState = {
    ...appendItem(state, item),
    [pendingKey]: id,
  } as TranscriptState;
  const hoistTarget = thinkingHoistTarget(state, event.turnId);
  return hoistTarget ? moveItemBefore(next, id, hoistTarget) : next;
}

export function finalizeMessage(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
  reasoningId?: string | undefined,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const ownedId =
    kind === "thinking" && reasoningId !== undefined
      ? (thinkingRowOwnedBy(state, event.turnId, reasoningId)?.id ??
        ownedPendingId(state, kind, reasoningId))
      : state[pendingKey];
  const pendingId = ownedId;
  let next = state;
  if (pendingId) {
    next = updateItem(next, pendingId, (item) => {
      if (kind === "assistant") {
        return { ...(item as AssistantItem), text, streaming: false };
      }
      const thinking = item as ThinkingItem;
      const content = finalizedThinkingContent(thinking.content, text, reasoningId);
      return {
        ...thinking,
        content,
        streaming: false,
        startedAt: thinking.startedAt ?? thinking.timestamp,
        endedAt: event.timestamp,
      };
    });
  } else {
    if (kind === "thinking") {
      const mergeTarget = lastAdjacentThinking(next, event.turnId, reasoningId);
      if (mergeTarget) {
        next = updateItem(next, mergeTarget.id, (item) => {
          const thinking = item as ThinkingItem;
          const existing = thinking.content;
          const content =
            !text.trim() || existing.trim().endsWith(text.trim())
              ? existing
              : joinThinkingChunks(existing, text);
          return {
            ...thinking,
            content,
            streaming: false,
            startedAt: thinking.startedAt ?? thinking.timestamp,
            endedAt: event.timestamp,
          };
        });
        return {
          ...next,
          [pendingKey]: undefined,
        };
      }
    }
    const id = `${kind}-${event.id}`;
    const base = {
      id,
      sequence: event.sequence,
      turnId: event.turnId,
      timestamp: event.timestamp,
    };
    const item: TranscriptItem =
      kind === "assistant"
        ? { ...base, kind: "assistant", text, streaming: false }
        : {
            ...base,
            kind: "thinking",
            content: text,
            streaming: false,
            startedAt: event.timestamp,
            endedAt: event.timestamp,
            ...(reasoningId !== undefined ? { reasoningId } : {}),
          };
    next = appendItem(next, item);
    if (
      kind === "thinking" &&
      next.pendingAssistantId &&
      isEmptyAssistantPlaceholder(next, next.pendingAssistantId)
    ) {
      next = moveItemBefore(next, id, next.pendingAssistantId);
    }
  }
  return {
    ...(kind === "assistant" ? clearStripStream(next, pendingId) : next),
    [pendingKey]: undefined,
  };
}

export function closePendingThinking(
  state: TranscriptState,
  endedAt: number,
): TranscriptState {
  if (!state.pendingThinkingId) return state;
  const next = updateItem(state, state.pendingThinkingId, (item) => {
    const thinking = item as ThinkingItem;
    return {
      ...thinking,
      streaming: false,
      startedAt: thinking.startedAt ?? thinking.timestamp,
      endedAt,
    };
  });
  return { ...next, pendingThinkingId: undefined };
}
