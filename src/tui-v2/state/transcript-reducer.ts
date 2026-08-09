/**
 * Pure transcript reducer (V2-050). Folds one `AnyAppEvent` into normalized
 * transcript state. Streaming deltas keep one open pending item per kind;
 * `assistant-message` / `thinking-block` finalize it. A real `tool-call`
 * discards any unfinalized assistant stream (raw tool-fence text). Event
 * order is preserved exactly as the model and tool runner emitted it.
 */

import type { AnyAppEvent } from "../../app/events/app-event.js";
import type {
  AssistantItem,
  CompactedItem,
  NoticeLevel,
  ThinkingItem,
  ToolItem,
  TranscriptItem,
  TranscriptState,
} from "./transcript-types.js";
import {
  isToolFenceOnlyText,
  stripToolCallSurfaces,
} from "../rendering/strip-tool-surfaces.js";
import {
  EMPTY_STRIP_STREAM,
  pushStripChunk,
  type StripStream,
} from "../rendering/incremental-strip.js";
import { appendItem, moveItemBefore, removeItem, updateItem } from "./transcript-struct.js";

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

function appendDelta(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const pendingId = state[pendingKey];
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
    }));
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
  };
  // Some models (e.g. Kimi K2-thinking) send reasoning_content tokens *after*
  // content tokens. Hoisting is only safe while the assistant row is still an
  // empty placeholder: moving thinking above prose the user has already read
  // makes painted rows jump and falsifies chronology.
  let next: TranscriptState = { ...appendItem(state, item), [pendingKey]: id } as TranscriptState;
  if (state.pendingAssistantId && isEmptyAssistantPlaceholder(state, state.pendingAssistantId)) {
    next = moveItemBefore(next, id, state.pendingAssistantId);
  }
  return next;
}

function finalizeMessage(
  state: TranscriptState,
  event: AnyAppEvent,
  kind: "assistant" | "thinking",
  text: string,
): TranscriptState {
  const pendingKey = kind === "assistant" ? "pendingAssistantId" : "pendingThinkingId";
  const pendingId = state[pendingKey];
  let next = state;
  if (pendingId) {
    next = updateItem(next, pendingId, (item) =>
      kind === "assistant"
        ? { ...(item as AssistantItem), text, streaming: false }
        : { ...(item as ThinkingItem), content: text, streaming: false },
    );
  } else {
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
        : { ...base, kind: "thinking", content: text, streaming: false };
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

function closePending(state: TranscriptState): TranscriptState {
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
    next = updateItem(next, next.pendingThinkingId, (item) => ({
      ...(item as ThinkingItem),
      streaming: false,
    }));
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
function closePendingThinking(state: TranscriptState): TranscriptState {
  if (!state.pendingThinkingId) return state;
  const next = updateItem(state, state.pendingThinkingId, (item) => ({
    ...(item as ThinkingItem),
    streaming: false,
  }));
  return { ...next, pendingThinkingId: undefined };
}

export function applyAppEvent(state: TranscriptState, event: AnyAppEvent): TranscriptState {
  if (event.sequence <= state.lastSequence) return state;
  const withSeq = withSequence(state, event.sequence);
  switch (event.type) {
    case "turn-started": {
      // Backend-only directives (implement/revision) pass displayPrompt=null.
      const display =
        event.payload.displayPrompt !== undefined
          ? event.payload.displayPrompt
          : event.payload.prompt;
      if (display === null || display === "") {
        return withSeq;
      }
      return appendItem(withSeq, {
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
      const base = visible ? closePendingThinking(withSeq) : withSeq;
      return {
        ...appendDelta(base, event, "assistant", event.payload.text),
        runningStatus: "responding",
      };
    }

    case "assistant-message": {
      const closed = closePendingThinking(withSeq);
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
        ...appendDelta(withSeq, event, "thinking", event.payload.text),
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
      return finalizeMessage(withSeq, event, "thinking", event.payload.content);
    }

    case "notice":
      // Chrome feedback only — composition-root surfaces these as toasts.
      // Never append INFO/WARN rows into the chat (inflates history item counts).
      return withSeq;

    case "tool-call": {
      const cleaned = discardPendingToolFenceStream(
        closePendingThinking(withSeq),
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
        discardPendingToolFenceStream(closePendingThinking(withSeq)),
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
      }));

    case "tool-blocked":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: "blocked",
        reason: event.payload.reason,
      }));

    case "compaction-started": {
      const id = `compacted-${event.payload.compactionId}`;
      if (withSeq.byId.has(id)) {
        return updateItem(withSeq, id, (item) => ({
          ...(item as CompactedItem),
          streaming: true,
          error: undefined,
          beforeTokens: event.payload.beforeTokens,
        }));
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
      });
    }

    case "compaction-delta": {
      const id = `compacted-${event.payload.compactionId}`;
      if (!withSeq.byId.has(id)) return withSeq;
      return updateItem(withSeq, id, (item) => ({
        ...(item as CompactedItem),
        summary: event.payload.replace
          ? event.payload.text
          : (item as CompactedItem).summary + event.payload.text,
        streaming: true,
      }));
    }

    case "compaction-completed": {
      const id = `compacted-${event.payload.compactionId}`;
      const completed: CompactedItem = {
        id,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "compacted",
        summary: event.payload.summary,
        beforeTokens: event.payload.beforeTokens,
        afterTokens: event.payload.afterTokens,
        streaming: false,
      };
      return withSeq.byId.has(id)
        ? updateItem(withSeq, id, () => completed)
        : appendItem(withSeq, completed);
    }

    case "compaction-failed": {
      const id = `compacted-${event.payload.compactionId}`;
      const existing = withSeq.byId.get(id);
      const retainedTokens =
        event.payload.retainedTokens ??
        (existing?.kind === "compacted" ? existing.beforeTokens : 0);
      const failed: CompactedItem = {
        id,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "compacted",
        summary: "",
        beforeTokens:
          existing?.kind === "compacted"
            ? existing.beforeTokens
            : retainedTokens,
        afterTokens: retainedTokens,
        streaming: false,
        error: event.payload.message,
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
      return { ...closePending(withSeq), runningStatus: undefined };

    case "turn-aborted": {
      const steered = event.payload.reason === "steer";
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        steered ? "info" : "warn",
        steered ? "Prompt steered." : "Turn aborted.",
      );
    }

    case "turn-error":
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        "error",
        event.payload.message,
      );

    case "plan-updated":
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
