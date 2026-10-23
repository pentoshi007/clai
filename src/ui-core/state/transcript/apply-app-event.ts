import type { AnyAppEvent, AppEvent, AppEventPayloads, AppEventType } from "../../../app/events/app-event.js";
import { sumLineChanges } from "../../../app/controllers/session-changes.js";
import { isProviderFailureStatus } from "../../../llm/key-rotation.js";
import { isToolFenceOnlyText, stripToolCallSurfaces } from "../../rendering/strip-tool-surfaces.js";
import { appendItem, removeItem, updateItem } from "../transcript-struct.js";
import type { AssistantItem, CompactedItem, NoticeLevel, ThinkingItem, TranscriptState, TurnSummaryItem } from "../transcript-types.js";
import { appendDelta, clearStripStream, closePendingThinking, finalizeMessage } from "./message-lifecycle.js";
import { settlePendingTools, toolEventHandlers } from "./tool-lifecycle.js";

type EventFor<K extends AppEventType> = Extract<AnyAppEvent, { type: K }>;

function pushNotice(state: TranscriptState, event: AnyAppEvent, level: NoticeLevel, text: string): TranscriptState {
  return appendItem(state, {
    id: `notice-${event.id}`, sequence: event.sequence, turnId: event.turnId,
    timestamp: event.timestamp, kind: "notice", level, text,
  });
}

function appendTurnSummary(
  state: TranscriptState,
  event: EventFor<"turn-ended" | "turn-aborted" | "turn-error">,
  status: TurnSummaryItem["status"],
): TranscriptState {
  const startedAt = state.activeTurnStartedAt;
  const changes = sumLineChanges(state.activeTurnChanges?.values() ?? []);
  const cleared = { ...state, activeTurnStartedAt: undefined, activeTurnId: undefined, activeTurnChanges: undefined };
  if (startedAt === undefined) return cleared;
  return appendItem(cleared, {
    id: `turn-summary-${event.id}`, sequence: event.sequence, turnId: event.turnId,
    timestamp: event.timestamp, kind: "turn-summary", durationMs: Math.max(0, event.timestamp - startedAt), status,
    ...(changes ? { changes } : {}), ...(event.payload.generation ? { generation: event.payload.generation } : {}),
  });
}

function closePending(state: TranscriptState, event: AnyAppEvent): TranscriptState {
  let next = settlePendingTools(state, event);
  if (next.pendingAssistantId) {
    next = updateItem(next, next.pendingAssistantId, item => ({ ...(item as AssistantItem), streaming: false }));
    next = clearStripStream(next, next.pendingAssistantId);
    next = { ...next, pendingAssistantId: undefined };
  }
  return { ...closePendingThinking(next, event.timestamp), runningStatus: undefined };
}

function turnThinkingContent(state: TranscriptState, turnId: string | undefined): string {
  const parts: string[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item?.kind !== "thinking" || item.turnId !== turnId) continue;
    const trimmed = item.content.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join("\n\n");
}

function applyTurnStarted(state: TranscriptState, event: EventFor<"turn-started">): TranscriptState {
  const started = { ...state, activeTurnStartedAt: event.timestamp, activeTurnId: event.turnId, activeTurnChanges: new Map() };
  const display = event.payload.displayPrompt !== undefined ? event.payload.displayPrompt : event.payload.prompt;
  if (display === null || display === "") return started;
  return appendItem(started, {
    id: `user-${event.id}`, sequence: event.sequence, turnId: event.turnId,
    timestamp: event.timestamp, kind: "user", text: display,
  });
}

function applyStatus(state: TranscriptState, event: EventFor<"status">): TranscriptState {
  const raw = event.payload.text ?? "";
  const trimmed = raw.replace(/\s+/g, " ").trim();
  if (!trimmed || trimmed.startsWith("ℹ") || isProviderFailureStatus(trimmed)) return state;
  if (trimmed.length > 80 && /error|failed|exception/i.test(trimmed)) return state;
  const next = /^(?:waiting|step \d+)$/.test(trimmed) ? settlePendingTools(state, event) : state;
  return { ...next, runningStatus: raw };
}

function applyAssistantDelta(state: TranscriptState, event: EventFor<"assistant-delta">): TranscriptState {
  const base = event.payload.text.trim().length > 0 ? closePendingThinking(state, event.timestamp) : state;
  return { ...appendDelta(base, event, "assistant", event.payload.text), runningStatus: "responding" };
}

function applyAssistantMessage(state: TranscriptState, event: EventFor<"assistant-message">): TranscriptState {
  const closed = closePendingThinking(state, event.timestamp);
  const text = stripToolCallSurfaces(event.payload.text).trim();
  if (!text || isToolFenceOnlyText(event.payload.text)) {
    if (!closed.pendingAssistantId) return { ...closed, runningStatus: undefined };
    return {
      ...clearStripStream(removeItem(closed, closed.pendingAssistantId), closed.pendingAssistantId),
      pendingAssistantId: undefined, runningStatus: undefined,
    };
  }
  return { ...finalizeMessage(closed, event, "assistant", text), runningStatus: undefined };
}

function applyThinkingDelta(state: TranscriptState, event: EventFor<"thinking-delta">): TranscriptState {
  return {
    ...appendDelta(state, event, "thinking", event.payload.text, event.payload.reasoningId),
    runningStatus: "thinking",
  };
}

function applyThinkingBlock(state: TranscriptState, event: EventFor<"thinking-block">): TranscriptState {
  if (!state.pendingThinkingId && turnThinkingContent(state, event.turnId) === event.payload.content.trim()) return state;
  return finalizeMessage(state, event, "thinking", event.payload.content, event.payload.reasoningId);
}

function applyCompactionStarted(state: TranscriptState, event: EventFor<"compaction-started">): TranscriptState {
  const id = `compacted-${event.payload.compactionId}`;
  if (state.byId.has(id)) {
    return updateItem(state, id, item => {
      const compacted = item as CompactedItem;
      return {
        ...compacted, streaming: true, error: undefined, beforeTokens: event.payload.beforeTokens,
        ...(event.payload.measurement ? { measurement: event.payload.measurement } : {}),
        startedAt: compacted.startedAt ?? event.timestamp, endedAt: undefined,
      };
    });
  }
  return appendItem(state, {
    id, sequence: event.sequence, turnId: event.turnId, timestamp: event.timestamp,
    kind: "compacted", summary: "", beforeTokens: event.payload.beforeTokens, afterTokens: event.payload.beforeTokens,
    ...(event.payload.measurement ? { measurement: event.payload.measurement } : {}),
    streaming: true, startedAt: event.timestamp,
  });
}

function applyCompactionDelta(state: TranscriptState, event: EventFor<"compaction-delta">): TranscriptState {
  const id = `compacted-${event.payload.compactionId}`;
  if (!state.byId.has(id)) return state;
  return updateItem(state, id, item => {
    const compacted = item as CompactedItem;
    return {
      ...compacted, summary: event.payload.replace ? event.payload.text : compacted.summary + event.payload.text,
      streaming: true, startedAt: compacted.startedAt ?? compacted.timestamp, endedAt: undefined,
    };
  });
}

function applyCompactionCompleted(state: TranscriptState, event: EventFor<"compaction-completed">): TranscriptState {
  const id = `compacted-${event.payload.compactionId}`;
  const existing = state.byId.get(id);
  const completed: CompactedItem = {
    ...(existing?.kind === "compacted" ? existing : { id, timestamp: event.timestamp, kind: "compacted" as const }),
    sequence: event.sequence, turnId: event.turnId, summary: event.payload.summary,
    beforeTokens: event.payload.beforeTokens, afterTokens: event.payload.afterTokens,
    ...(event.payload.measurement ? { measurement: event.payload.measurement } : {}),
    streaming: false, error: undefined,
    startedAt: existing?.kind === "compacted" ? existing.startedAt ?? existing.timestamp : event.timestamp,
    endedAt: event.timestamp, originalItems: [],
  };
  return existing ? updateItem(state, id, () => completed) : appendItem(state, completed);
}

function applyCompactionFailed(state: TranscriptState, event: EventFor<"compaction-failed">): TranscriptState {
  const id = `compacted-${event.payload.compactionId}`;
  const existing = state.byId.get(id);
  const retainedTokens = event.payload.retainedTokens ?? (existing?.kind === "compacted" ? existing.beforeTokens : 0);
  const failed: CompactedItem = {
    ...(existing?.kind === "compacted" ? existing : {
      id, timestamp: event.timestamp, kind: "compacted" as const, beforeTokens: retainedTokens,
    }),
    sequence: event.sequence, turnId: event.turnId, summary: "", afterTokens: retainedTokens,
    streaming: false, error: event.payload.message,
    startedAt: existing?.kind === "compacted" ? existing.startedAt ?? existing.timestamp : event.timestamp,
    endedAt: event.timestamp,
  };
  return existing ? updateItem(state, id, () => failed) : appendItem(state, failed);
}

function applyCompacted(state: TranscriptState, event: EventFor<"compacted">): TranscriptState {
  return appendItem(state, {
    id: `compacted-${event.id}`, sequence: event.sequence, turnId: event.turnId,
    timestamp: event.timestamp, kind: "compacted", summary: event.payload.summary,
    beforeTokens: event.payload.beforeTokens, afterTokens: event.payload.afterTokens, streaming: false,
  });
}

function applyTurnEnded(state: TranscriptState, event: EventFor<"turn-ended">): TranscriptState {
  return appendTurnSummary(closePending(state, event), event, "completed");
}

function applyTurnAborted(state: TranscriptState, event: EventFor<"turn-aborted">): TranscriptState {
  const steered = event.payload.reason === "steer";
  const next = pushNotice(closePending(state, event), event, steered ? "info" : "warn", steered ? "Prompt steered." : "Turn aborted.");
  return appendTurnSummary(next, event, "aborted");
}

function applyTurnError(state: TranscriptState, event: EventFor<"turn-error">): TranscriptState {
  return appendTurnSummary(pushNotice(closePending(state, event), event, "error", event.payload.message), event, "error");
}

const unchanged = (state: TranscriptState): TranscriptState => state;

const eventHandlers: { [K in AppEventType]: (state: TranscriptState, event: AppEvent<K, AppEventPayloads[K]>) => TranscriptState } = {
  "turn-started": applyTurnStarted,
  status: applyStatus,
  "assistant-delta": applyAssistantDelta,
  "assistant-message": applyAssistantMessage,
  "thinking-delta": applyThinkingDelta,
  "thinking-block": applyThinkingBlock,
  notice: unchanged,
  ...toolEventHandlers,
  "compaction-started": applyCompactionStarted,
  "compaction-delta": applyCompactionDelta,
  "compaction-completed": applyCompactionCompleted,
  "compaction-failed": applyCompactionFailed,
  compacted: applyCompacted,
  "turn-ended": applyTurnEnded,
  "turn-aborted": applyTurnAborted,
  "turn-error": applyTurnError,
  "plan-updated": unchanged,
  "plan-cleared": unchanged,
  "confirm-requested": unchanged,
  "token-usage": unchanged,
};

export class TranscriptSequenceError extends Error {
  constructor(readonly expected: number, readonly received: number) {
    super(`transcript sequence gap: expected ${expected} but received ${received} — events must reach the store in gap-free order (event ${expected} was never seen)`);
    this.name = "TranscriptSequenceError";
  }
}

export function applyAppEvent<K extends AppEventType>(state: TranscriptState, event: AppEvent<K, AppEventPayloads[K]>): TranscriptState {
  if (event.sequence <= state.lastSequence) return state;
  if (event.sequence > state.lastSequence + 1) throw new TranscriptSequenceError(state.lastSequence + 1, event.sequence);
  return eventHandlers[event.type]({ ...state, lastSequence: event.sequence }, event);
}
