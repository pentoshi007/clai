import type { AnyAppEvent } from "../../../app/events/app-event.js";
import { isProviderFailureStatus } from "../../../llm/key-rotation.js";
import { isToolFenceOnlyText, stripToolCallSurfaces } from "../../rendering/strip-tool-surfaces.js";
import { appendItem, removeItem, updateItem } from "../transcript-struct.js";
import type { AssistantItem, CompactedItem, NoticeLevel, ThinkingItem, ToolItem, TranscriptState, TurnSummaryItem } from "../transcript-types.js";
import { appendDelta, clearStripStream, closePendingThinking, discardPendingToolFenceStream, finalizeMessage } from "./message-lifecycle.js";

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

function withSequence(state: TranscriptState, sequence: number): TranscriptState {
  return { ...state, lastSequence: sequence };
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

    case "status": {
      const raw = event.payload.text ?? "";
      const trimmed = raw.replace(/\s+/g, " ").trim();
      if (!trimmed) return withSeq;
      if (trimmed.startsWith("ℹ")) return withSeq;
      if (isProviderFailureStatus(trimmed)) return withSeq;
      if (trimmed.length > 80 && /error|failed|exception/i.test(trimmed)) return withSeq;
      return { ...withSeq, runningStatus: raw };
    }

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
      return withSeq;

    default: {
      const unreachable: never = event;
      throw new Error(`unhandled AppEvent: ${JSON.stringify(unreachable)}`);
    }
  }
}
