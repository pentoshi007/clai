/**
 * Pure transcript reducer (V2-050). Folds one `AnyAppEvent` into normalized
 * transcript state. Streaming deltas keep one open pending item per kind;
 * `assistant-message` / `thinking-block` finalize it. A real `tool-call`
 * discards any unfinalized assistant stream (raw tool-fence text) so display
 * order is thinking → Response prose → tool cards.
 */

import type { AnyAppEvent } from "../../app/events/app-event.js";
import type {
  AssistantItem,
  NoticeLevel,
  ThinkingItem,
  ToolItem,
  TranscriptItem,
  TranscriptState,
} from "./transcript-types.js";
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

/** Drop streaming assistant that was only tool-fence text (Ink TUI parity). */
function discardPendingToolFenceStream(state: TranscriptState): TranscriptState {
  if (!state.pendingAssistantId) return state;
  const pending = state.byId.get(state.pendingAssistantId);
  if (!pending || pending.kind !== "assistant" || !pending.streaming) {
    return { ...state, pendingAssistantId: undefined };
  }
  return {
    ...removeItem(state, state.pendingAssistantId),
    pendingAssistantId: undefined,
  };
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
    return updateItem(state, pendingId, (item) =>
      kind === "assistant"
        ? { ...(item as AssistantItem), text: (item as AssistantItem).text + text }
        : { ...(item as ThinkingItem), content: (item as ThinkingItem).content + text },
    );
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
      ? { ...base, kind: "assistant", text, streaming: true }
      : { ...base, kind: "thinking", content: text, streaming: true };
  // Streaming thinking stays in append order (after prior responses). Reordering
  // is only for late one-shot thinking-block finalizes (see finalizeMessage).
  return { ...appendItem(state, item), [pendingKey]: id } as TranscriptState;
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
  /** True when this thinking row was already streaming in place (correct order). */
  let hadStreamingThinking = false;
  let thinkingId: string | undefined;
  if (pendingId) {
    next = updateItem(next, pendingId, (item) =>
      kind === "assistant"
        ? { ...(item as AssistantItem), text, streaming: false }
        : { ...(item as ThinkingItem), content: text, streaming: false },
    );
    if (kind === "thinking") {
      thinkingId = pendingId;
      hadStreamingThinking = true;
    }
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
    if (kind === "thinking") thinkingId = id;
  }
  next = { ...next, [pendingKey]: undefined };
  // Late one-shot thinking-block (e.g. stripThinking after assistant-message)
  // is appended after ◆ Response — pull it above the latest response of this
  // turn only. Do not move streaming thinking (multi-step: resp1 → think2 →
  // resp2) or pile every think before the *first* response of the turn.
  if (thinkingId && !hadStreamingThinking) {
    next = ensureThinkingBeforeLatestAssistant(next, thinkingId, event.turnId);
  }
  return next;
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
 * Keep classic display order for a *late* thinking-block: place it immediately
 * before the **latest** ◆ Response of the same turn (not the first).
 *
 * Multi-step turns emit think → respond → think → respond. Moving every think
 * before the *first* assistant stacked all ▸ thinking rows at the top of the
 * turn. Only one-shot late blocks (no prior thinking-delta stream) call this.
 */
function ensureThinkingBeforeLatestAssistant(
  state: TranscriptState,
  thinkingId: string,
  turnId: TranscriptItem["turnId"],
): TranscriptState {
  let latestAssistantId: string | undefined;
  for (const id of state.order) {
    if (id === thinkingId) continue;
    const item = state.byId.get(id);
    if (!item || item.kind !== "assistant") continue;
    if (turnId !== undefined && item.turnId !== turnId) continue;
    if (turnId === undefined && item.turnId !== undefined) continue;
    latestAssistantId = id;
  }
  if (!latestAssistantId) return state;
  const thinkingIdx = state.order.indexOf(thinkingId);
  const assistantIdx = state.order.indexOf(latestAssistantId);
  // Already above the latest response (or missing) — leave append order alone.
  if (thinkingIdx < 0 || assistantIdx < 0 || thinkingIdx < assistantIdx) return state;
  return moveItemBefore(state, thinkingId, latestAssistantId);
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
    case "turn-started":
      return appendItem(withSeq, {
        id: `user-${event.id}`,
        sequence: event.sequence,
        turnId: event.turnId,
        timestamp: event.timestamp,
        kind: "user",
        text: event.payload.prompt,
      });

    case "status":
      return { ...withSeq, runningStatus: event.payload.text };

    case "assistant-delta":
      return {
        ...appendDelta(withSeq, event, "assistant", event.payload.text),
        runningStatus: "responding",
      };

    case "assistant-message": {
      const text = event.payload.text.trim();
      if (!text) {
        if (withSeq.pendingAssistantId) {
          return {
            ...removeItem(withSeq, withSeq.pendingAssistantId),
            pendingAssistantId: undefined,
          };
        }
        return withSeq;
      }
      return finalizeMessage(withSeq, event, "assistant", text);
    }

    case "thinking-delta":
      return {
        ...appendDelta(withSeq, event, "thinking", event.payload.text),
        runningStatus: "thinking",
      };

    case "thinking-block":
      return finalizeMessage(withSeq, event, "thinking", event.payload.content);

    case "notice":
      return pushNotice(withSeq, event, event.payload.level, event.payload.text);

    case "tool-call": {
      // Close open streams so cards never interleave under live thinking /
      // raw fence text. Then append the tool row (thinking → response → tools).
      const cleaned = discardPendingToolFenceStream(closePendingThinking(withSeq));
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
        status: "running",
        exitCode: undefined,
        summary: undefined,
        artifactPath: undefined,
        reason: undefined,
        outputBytes: 0,
      };
      return {
        ...appendItem(cleaned, item),
        runningStatus: event.payload.name,
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
      }));

    case "tool-blocked":
      return updateToolItem(withSeq, event.payload.toolCallId, (item) => ({
        ...item,
        status: "blocked",
        reason: event.payload.reason,
      }));

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
      });

    case "turn-ended":
      return { ...closePending(withSeq), runningStatus: undefined };

    case "turn-aborted":
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        "warn",
        "Turn aborted.",
      );

    case "turn-error":
      return pushNotice(
        { ...closePending(withSeq), runningStatus: undefined },
        event,
        "error",
        event.payload.message,
      );

    case "plan-updated":
    case "confirm-requested":
      return withSeq;

    default: {
      const unreachable: never = event;
      throw new Error(`unhandled AppEvent: ${JSON.stringify(unreachable)}`);
    }
  }
}
