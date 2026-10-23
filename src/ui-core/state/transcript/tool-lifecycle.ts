import type { AnyAppEvent } from "../../../app/events/app-event.js";
import { fileLineChanges, sumLineChanges } from "../../../app/controllers/session-changes.js";
import { appendItem, updateItem } from "../transcript-struct.js";
import type { AssistantItem, ToolItem, TranscriptState } from "../transcript-types.js";
import { clearStripStream, closePendingThinking, discardPendingToolFenceStream } from "./message-lifecycle.js";

type ToolEvent<K extends AnyAppEvent["type"]> = Extract<AnyAppEvent, { type: K }>;

function updateToolItem(state: TranscriptState, toolCallId: ToolItem["toolCallId"], update: (item: ToolItem) => ToolItem): TranscriptState {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.byId.get(state.order[index]!);
    if (item?.kind === "tool" && item.toolCallId === toolCallId) {
      return updateItem(state, item.id, () => update(item));
    }
  }
  return state;
}

export function settlePendingTools(state: TranscriptState, event: AnyAppEvent): TranscriptState {
  let next = state;
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.byId.get(state.order[index]!);
    if (item?.kind !== "tool" || !item.pending || item.turnId !== event.turnId) continue;
    next = updateItem(next, item.id, () => ({
      ...item, pending: false, status: "blocked", endedAt: event.timestamp,
      reason: "This tool call was not completed. Nothing ran.",
    }));
  }
  return next;
}

function applyToolCall(state: TranscriptState, event: ToolEvent<"tool-call">): TranscriptState {
  const cleaned = discardPendingToolFenceStream(closePendingThinking(state, event.timestamp));
  for (let index = cleaned.order.length - 1; index >= 0; index -= 1) {
    const existing = cleaned.byId.get(cleaned.order[index]!);
    if (existing?.kind !== "tool" || existing.turnId !== event.turnId || existing.toolCallId !== event.payload.toolCallId) continue;
    if (existing.status !== "queued") {
      if (event.payload.pending) return cleaned;
      continue;
    }
    if (!existing.pending && event.payload.pending) return cleaned;
    return {
      ...updateItem(cleaned, existing.id, () => ({
        ...existing, name: event.payload.name, argsDisplay: event.payload.argsDisplay,
        pending: event.payload.pending === true,
      })),
      runningStatus: "preparing tools",
    };
  }
  const item: ToolItem = {
    id: `tool-${event.id}`, sequence: event.sequence, turnId: event.turnId, timestamp: event.timestamp,
    kind: "tool", toolCallId: event.payload.toolCallId, name: event.payload.name,
    argsDisplay: event.payload.argsDisplay, pending: event.payload.pending === true, status: "queued",
    exitCode: undefined, summary: undefined, artifactPath: undefined, reason: undefined,
    outputBytes: 0, fileChanges: undefined,
  };
  return { ...appendItem(cleaned, item), runningStatus: "preparing tools" };
}

function closePendingAssistant(state: TranscriptState): TranscriptState {
  if (!state.pendingAssistantId) return state;
  const next = clearStripStream(
    updateItem(state, state.pendingAssistantId, item => ({ ...(item as AssistantItem), streaming: false })),
    state.pendingAssistantId,
  );
  return { ...next, pendingAssistantId: undefined };
}

function applyToolStarted(state: TranscriptState, event: ToolEvent<"tool-started">): TranscriptState {
  const started = closePendingAssistant(discardPendingToolFenceStream(closePendingThinking(state, event.timestamp)));
  let startedName: string | undefined;
  const next = updateToolItem(started, event.payload.toolCallId, item => {
    startedName = item.name;
    return {
      ...item, pending: false, status: item.status === "queued" ? "running" : item.status,
      ...(item.status === "queued" ? { startedAt: event.timestamp } : {}),
    };
  });
  return { ...next, runningStatus: startedName ?? started.runningStatus };
}

function applyToolOutput(state: TranscriptState, event: ToolEvent<"tool-output">): TranscriptState {
  return updateToolItem(state, event.payload.ref.toolCallId, item => ({ ...item, outputBytes: event.payload.ref.totalBytes }));
}

function applyToolResult(state: TranscriptState, event: ToolEvent<"tool-result">): TranscriptState {
  const updated = updateToolItem(state, event.payload.toolCallId, item => ({
    ...item, pending: false, status: event.payload.ok || event.payload.runFailure === false ? "ok" : "failed",
    exitCode: event.payload.exitCode, summary: event.payload.summary, artifactPath: event.payload.artifactPath,
    fileChanges: event.payload.fileChanges ?? item.fileChanges, endedAt: event.timestamp,
  }));
  const changes = sumLineChanges(fileLineChanges(event.payload.fileChanges));
  if (!changes || !state.activeTurnChanges || event.turnId !== state.activeTurnId) return updated;
  const activeTurnChanges = new Map(state.activeTurnChanges);
  activeTurnChanges.set(event.payload.toolCallId, changes);
  return { ...updated, activeTurnChanges };
}

function applyToolBlocked(state: TranscriptState, event: ToolEvent<"tool-blocked">): TranscriptState {
  return updateToolItem(state, event.payload.toolCallId, item => ({
    ...item, pending: false, status: "blocked", reason: event.payload.reason, endedAt: event.timestamp,
  }));
}

export const toolEventHandlers = {
  "tool-call": applyToolCall,
  "tool-started": applyToolStarted,
  "tool-output": applyToolOutput,
  "tool-result": applyToolResult,
  "tool-blocked": applyToolBlocked,
};
