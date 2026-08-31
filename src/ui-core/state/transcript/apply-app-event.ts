import type { AnyAppEvent } from "../../../app/events/app-event.js";
import { EMPTY_STRIP_STREAM, pushStripChunk } from "../../rendering/incremental-strip.js";
import type { StripStream } from "../../rendering/incremental-strip.js";
import { isToolFenceOnlyText, stripToolCallSurfaces } from "../../rendering/strip-tool-surfaces.js";
import { appendItem, moveItemBefore, removeItem, updateItem } from "../transcript-struct.js";
import type { AssistantItem, CompactedItem, NoticeLevel, ThinkingItem, ToolItem, TranscriptItem, TranscriptState, TurnSummaryItem } from "../transcript-types.js";

function updateToolItem(
  state: TranscriptState,
  toolCallId: ToolItem["toolCallId"],
  update: (item: ToolItem) => ToolItem,
): TranscriptState {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.byId.get(state.order[index]!);
    if (item?.kind === "tool" && item.toolCallId === toolCallId) {
      return updateItem(state, item.id, (existing) => update(existing as ToolItem));
    }
  }
  return state;
}

/**
 * Drop or clean streaming assistant text that is (or was) only tool-fence
 * surfaces so raw ```tool JSON never sticks on screen once tool cards land.
 */
function discardPendingToolFenceStream(state: TranscriptState): TranscriptState {
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

/**
 * True when the open assistant row has no visible text yet, so inserting an
 * item before it cannot move anything the user has already seen.
 */
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

function clearStripStream(state: TranscriptState, id: string | undefined): TranscriptState {
  if (!id || !state.assistantStripStreams.has(id)) return state;
  const streams = new Map(state.assistantStripStreams);
  streams.delete(id);
  return { ...state, assistantStripStreams: streams };
}

function withSequence(state: TranscriptState, sequence: number): TranscriptState {
  return { ...state, lastSequence: sequence };
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

function appendDelta(
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
    // Fence-only start of a stream: hold an empty pending row so later prose
    // can still attach; tool-call events will discard empty fences.
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

function finalizeMessage(
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
    // Same rule as streaming deltas: only hoist above an assistant row that has
    // not painted any text yet.
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

function pushNotice(
  state: TranscriptState,
  event: AnyAppEvent,
  level: NoticeLevel,
  text: string,
): TranscriptState {
  return appendItem(state, {
    id: `notice-${event.id}`,
    sequence: event.sequence,
    turnId: event.turnId,
    timestamp: event.timestamp,
    kind: "notice",
    level,
    text,
  });
}

function appendTurnSummary(
  state: TranscriptState,
  event: AnyAppEvent,
  status: TurnSummaryItem["status"],
): TranscriptState {
  const startedAt = state.activeTurnStartedAt;
  const cleared: TranscriptState = { ...state, activeTurnStartedAt: undefined };
  if (startedAt === undefined) return cleared;
  return appendItem(cleared, {
    id: `turn-summary-${event.id}`,
    sequence: event.sequence,
    turnId: event.turnId,
    timestamp: event.timestamp,
    kind: "turn-summary",
    durationMs: Math.max(0, event.timestamp - startedAt),
    status,
  });
}

function closePending(state: TranscriptState, endedAt: number): TranscriptState {
  let next = state;
  if (next.pendingAssistantId) {
    next = updateItem(next, next.pendingAssistantId, (item) => ({
      ...(item as AssistantItem),
      streaming: false,
    }));
    next = clearStripStream(next, next.pendingAssistantId);
    next = { ...next, pendingAssistantId: undefined };
  }
  if (next.pendingThinkingId) {
    next = updateItem(next, next.pendingThinkingId, (item) => {
      const thinking = item as ThinkingItem;
      return {
        ...thinking,
        streaming: false,
        startedAt: thinking.startedAt ?? thinking.timestamp,
        endedAt,
      };
    });
    next = { ...next, pendingThinkingId: undefined };
  }
  return next;
}

/**
 * Close the open assistant row without removing it. Empty/fence-only rows are
 * already dropped by `discardPendingToolFenceStream`, so anything still open
 * here carries real prose that must stay where it was painted.
 */
function closePendingAssistant(state: TranscriptState): TranscriptState {
  if (!state.pendingAssistantId) return state;
  const next = clearStripStream(
    updateItem(state, state.pendingAssistantId, (item) => ({
      ...(item as AssistantItem),
      streaming: false,
    })),
    state.pendingAssistantId,
  );
  return { ...next, pendingAssistantId: undefined };
}

function turnThinkingContent(
  state: TranscriptState,
  turnId: string | undefined,
): string {
  const parts: string[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item?.kind !== "thinking" || item.turnId !== turnId) continue;
    const trimmed = item.content.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join("\n\n");
}

/** Close open thinking so tool cards never sit under a still-streaming block. */
function closePendingThinking(
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

export class TranscriptSequenceError extends Error {
  constructor(
    readonly expected: number,
    readonly received: number,
  ) {
    super(
      `transcript sequence gap: expected ${expected} but received ${received} — ` +
        `events must reach the store in gap-free order (event ${expected} was never seen)`,
    );
    this.name = "TranscriptSequenceError";
  }
}

export function applyAppEvent(state: TranscriptState, event: AnyAppEvent): TranscriptState {
  if (event.sequence <= state.lastSequence) return state;
  if (event.sequence > state.lastSequence + 1) {
    throw new TranscriptSequenceError(state.lastSequence + 1, event.sequence);
  }
  const withSeq = withSequence(state, event.sequence);
  switch (event.type) {
    case "turn-started": {
      // Backend-only directives (implement/revision) pass displayPrompt=null.
      const display =
        event.payload.displayPrompt !== undefined
          ? event.payload.displayPrompt
          : event.payload.prompt;
      if (display === null || display === "") {
        return { ...withSeq, activeTurnStartedAt: event.timestamp };
      }
      return appendItem({ ...withSeq, activeTurnStartedAt: event.timestamp }, {
        id: `user-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "user",
        text: display,
      });
    }

    case "status":
      return { ...withSeq, runningStatus: event.payload.text };

    case "assistant-delta": {
      const visible = event.payload.text.trim().length > 0;
      const base = visible ? closePendingThinking(withSeq, event.timestamp) : withSeq;
      return {
        ...appendDelta(base, event, "assistant", event.payload.text),
        runningStatus: "responding",
      };
    }

    case "assistant-message": {
      const closed = closePendingThinking(withSeq, event.timestamp);
      // Never finalize a Response card that is only tool-call fences.
      const text = stripToolCallSurfaces(event.payload.text).trim();
      if (!text || isToolFenceOnlyText(event.payload.text)) {
        if (closed.pendingAssistantId) {
          return {
            ...clearStripStream(
              removeItem(closed, closed.pendingAssistantId),
              closed.pendingAssistantId,
            ),
            pendingAssistantId: undefined,
            runningStatus: undefined,
          };
        }
        return {
          ...closed,
          runningStatus: undefined,
        };
      }
      return {
        ...finalizeMessage(closed, event, "assistant", text),
        runningStatus: undefined,
      };
    }

    case "thinking-delta":
      return {
        ...appendDelta(
          withSeq,
          event,
          "thinking",
          event.payload.text,
          event.payload.reasoningId,
        ),
        runningStatus: "thinking",
      };

    case "thinking-block": {
      if (
        !withSeq.pendingThinkingId &&
        turnThinkingContent(withSeq, event.turnId) ===
          event.payload.content.trim()
      ) {
        return withSeq;
      }
      return finalizeMessage(
        withSeq,
        event,
        "thinking",
        event.payload.content,
        event.payload.reasoningId,
      );
    }

    case "notice":
      // Chrome feedback only — composition-root surfaces these as toasts.
      // Never append INFO/WARN rows into the chat (inflates history item counts).
      return withSeq;

    case "tool-call": {
      const cleaned = discardPendingToolFenceStream(
        closePendingThinking(withSeq, event.timestamp),
      );
      for (let index = cleaned.order.length - 1; index >= 0; index -= 1) {
        const existing = cleaned.byId.get(cleaned.order[index]!);
        if (
          existing?.kind === "tool" &&
          existing.status === "queued" &&
          existing.turnId === event.turnId &&
          existing.toolCallId === event.payload.toolCallId
        ) {
          return {
            ...updateItem(cleaned, existing.id, (item) => ({
              ...(item as ToolItem),
              name: event.payload.name,
              argsDisplay: event.payload.argsDisplay,
            })),
            runningStatus: "preparing tools",
          };
        }
      }
      const item: ToolItem = {
        // Occurrence id stays unique even if the agent reuses tool-1 next turn.
        id: `tool-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "tool",
        toolCallId: event.payload.toolCallId,
        name: event.payload.name,
        argsDisplay: event.payload.argsDisplay,
        status: "queued",
        exitCode: undefined,
        summary: undefined,
        artifactPath: undefined,
        reason: undefined,
        outputBytes: 0,
        fileChanges: undefined,
      };
      return {
        ...appendItem(cleaned, item),
        // Don't set activity to this name yet — card is only queued.
        runningStatus: "preparing tools",
      };
    }

    case "tool-started": {
      const started = closePendingAssistant(
        discardPendingToolFenceStream(closePendingThinking(withSeq, event.timestamp)),
      );
      let startedName: string | undefined;
      for (let i = started.order.length - 1; i >= 0; i -= 1) {
        const it = started.byId.get(started.order[i]!);
        if (it?.kind === "tool" && it.toolCallId === event.payload.toolCallId) {
          startedName = it.name;
          break;
        }
      }
      return {
        ...updateToolItem(started, event.payload.toolCallId, (item) => ({
          ...item,
          status: item.status === "queued" ? "running" : item.status,
          // Record the real start wall-clock so the elapsed timer begins only
          // when the command actually runs — not when it was queued.
          ...(item.status === "queued" ? { startedAt: event.timestamp } : {}),
        })),
        runningStatus: startedName ?? started.runningStatus,
      };
    }

    case "tool-output":
      return updateToolItem(withSeq, event.payload.ref.toolCallId, (item) => ({
        ...item,
        outputBytes: event.payload.ref.totalBytes,
      }));

    case "tool-result":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: event.payload.ok ? "ok" : "failed",
        exitCode: event.payload.exitCode,
        summary: event.payload.summary,
        artifactPath: event.payload.artifactPath,
        fileChanges: event.payload.fileChanges ?? item.fileChanges,
        endedAt: event.timestamp,
      }));

    case "tool-blocked":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: "blocked",
        reason: event.payload.reason,
        endedAt: event.timestamp,
      }));

    case "compaction-started": {
      const id = `compacted-${event.payload.compactionId}`;
      if (withSeq.byId.has(id)) {
        return updateItem(withSeq, id, (item) => {
          const compacted = item as CompactedItem;
          return {
            ...compacted,
            streaming: true,
            error: undefined,
            beforeTokens: event.payload.beforeTokens,
            startedAt: compacted.startedAt ?? event.timestamp,
            endedAt: undefined,
          };
        });
      }
      return appendItem(withSeq, {
        id,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "compacted",
        summary: "",
        beforeTokens: event.payload.beforeTokens,
        afterTokens: event.payload.beforeTokens,
        streaming: true,
        startedAt: event.timestamp,
      });
    }

    case "compaction-delta": {
      const id = `compacted-${event.payload.compactionId}`;
      if (!withSeq.byId.has(id)) return withSeq;
      return updateItem(withSeq, id, (item) => {
        const compacted = item as CompactedItem;
        return {
          ...compacted,
          summary: event.payload.replace
            ? event.payload.text
            : compacted.summary + event.payload.text,
          streaming: true,
          startedAt: compacted.startedAt ?? compacted.timestamp,
          endedAt: undefined,
        };
      });
    }

    case "compaction-completed": {
      const id = `compacted-${event.payload.compactionId}`;
      const existing = withSeq.byId.get(id);
      const completed: CompactedItem =
        existing?.kind === "compacted"
          ? {
              ...existing,
              sequence: event.sequence,
              turnId: event.turnId,
              summary: event.payload.summary,
              beforeTokens: event.payload.beforeTokens,
              afterTokens: event.payload.afterTokens,
              streaming: false,
              error: undefined,
              startedAt: existing.startedAt ?? existing.timestamp,
              endedAt: event.timestamp,
            }
          : {
              id,
              sequence: event.sequence,
              turnId: event.turnId,
              timestamp: event.timestamp,
              kind: "compacted",
              summary: event.payload.summary,
              beforeTokens: event.payload.beforeTokens,
              afterTokens: event.payload.afterTokens,
              streaming: false,
              startedAt: event.timestamp,
              endedAt: event.timestamp,
            };
      return existing
        ? updateItem(withSeq, id, () => completed)
        : appendItem(withSeq, completed);
    }

    case "compaction-failed": {
      const id = `compacted-${event.payload.compactionId}`;
      const existing = withSeq.byId.get(id);
      const retainedTokens =
        event.payload.retainedTokens ??
        (existing?.kind === "compacted" ? existing.beforeTokens : 0);
      const failed: CompactedItem =
        existing?.kind === "compacted"
          ? {
              ...existing,
              sequence: event.sequence,
              turnId: event.turnId,
              summary: "",
              afterTokens: retainedTokens,
              streaming: false,
              error: event.payload.message,
              startedAt: existing.startedAt ?? existing.timestamp,
              endedAt: event.timestamp,
            }
          : {
              id,
              sequence: event.sequence,
              turnId: event.turnId,
              timestamp: event.timestamp,
              kind: "compacted",
              summary: "",
              beforeTokens: retainedTokens,
              afterTokens: retainedTokens,
              streaming: false,
              error: event.payload.message,
              startedAt: event.timestamp,
              endedAt: event.timestamp,
            };
      return existing
        ? updateItem(withSeq, id, () => failed)
        : appendItem(withSeq, failed);
    }

    case "compacted":
      return appendItem(withSeq, {
        id: `compacted-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "compacted",
        summary: event.payload.summary,
        beforeTokens: event.payload.beforeTokens,
        afterTokens: event.payload.afterTokens,
        streaming: false,
      });

    case "turn-ended":
      return appendTurnSummary(
        { ...closePending(withSeq, event.timestamp), runningStatus: undefined },
        event,
        "completed",
      );

    case "turn-aborted": {
      const steered = event.payload.reason === "steer";
      return appendTurnSummary(
        pushNotice(
          { ...closePending(withSeq, event.timestamp), runningStatus: undefined },
          event,
          steered ? "info" : "warn",
          steered ? "Prompt steered." : "Turn aborted.",
        ),
        event,
        "aborted",
      );
    }

    case "turn-error":
      return appendTurnSummary(
        pushNotice(
          { ...closePending(withSeq, event.timestamp), runningStatus: undefined },
          event,
          "error",
          event.payload.message,
        ),
        event,
        "error",
      );

    case "plan-updated":
    case "plan-cleared":
    case "confirm-requested":
    case "token-usage":
    case "context-estimate":
      // SessionController records usage; transcript does not need a card.
      return withSeq;

    default: {
      const unreachable: never = event;
      throw new Error(`unhandled AppEvent: ${JSON.stringify(unreachable)}`);
    }
  }
}
