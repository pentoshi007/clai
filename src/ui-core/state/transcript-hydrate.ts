
import { type ChatMessage } from "../../types.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../app/ports/transcript-item.js";
import { type ToolCallId } from "../../app/events/app-event.js";
import { type TranscriptState } from "./transcript-types.js";
import { flattenTranscriptHistory } from "./transcript-history.js";
import { HydrateResult, hydrateFromClassicTranscript } from "./hydrate/classic-transcript.js";
import { enrichToolsFromMessages, hydrateFromMessages } from "./hydrate/from-messages.js";
export { fileChangesFromToolArgs } from "./hydrate/from-messages.js";
export { hydrateFromMessages };
export { hydrateFromClassicTranscript };
export type { HydrateResult } from "./hydrate/classic-transcript.js";

function countFileChangeTools(state: TranscriptState): number {
  let n = 0;
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (
      item?.kind === "tool" &&
      item.fileChanges &&
      item.fileChanges.length > 0
    ) {
      n += 1;
    }
  }
  return n;
}

export function transcriptLooksIncomplete(
  transcriptLen: number,
  messages: readonly ChatMessage[],
): boolean {
  const toolMsgCount = messages.filter((m) => m.role === "tool").length;
  const toolCallCount = messages.reduce(
    (n, m) => n + (m.toolCalls?.length ?? 0),
    0,
  );
  const toolWork = Math.max(toolMsgCount, toolCallCount);
  if (toolWork === 0) return false;
  return transcriptLen < toolWork + 1;
}


export interface SessionVisualInput {
  readonly transcript: ClassicTranscriptItem[] | undefined;
  readonly messages: ChatMessage[];
}

const RESTORED_TOOL_ARGS = { restored: "Arguments available in the full session record" };

function visualMessage(message: ChatMessage): ChatMessage {
  if (!message.toolCalls) return message;
  return {
    ...message,
    toolCalls: message.toolCalls.map((call) => ({
      ...call,
      args: RESTORED_TOOL_ARGS,
      rawArguments: undefined,
    })),
  };
}

export function prepareSessionVisualInput(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): SessionVisualInput {
  return {
    transcript: transcript ? flattenTranscriptHistory(transcript) : undefined,
    messages: messages.map(visualMessage),
  };
}

export function hydrateSessionVisual(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): HydrateResult {
  const fromMessages = hydrateFromMessages(messages);
  if (!transcript || transcript.length === 0) {
    return fromMessages;
  }
  const fromClassic = enrichToolsFromMessages(
    hydrateFromClassicTranscript(transcript),
    messages,
  );
  const classicToolCount = [...fromClassic.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  const messageToolCount = [...fromMessages.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  const classicFc = countFileChangeTools(fromClassic.state);
  const messageFc = countFileChangeTools(fromMessages.state);

  if (classicFc > messageFc) return fromClassic;
  if (messageFc > classicFc && messageToolCount >= classicToolCount) {
    return fromMessages;
  }
  if (messageToolCount > classicToolCount + 2) return fromMessages;
  if (fromMessages.state.order.length > fromClassic.state.order.length * 1.5) {
    return fromMessages;
  }
  return fromClassic;
}

type AnyTranscriptItem =
  | import("./transcript-types.js").TranscriptItem
  | ClassicTranscriptItem;

function serializeTranscriptItem(
  item: AnyTranscriptItem,
  resolveToolOutput: (item: AnyTranscriptItem) => string,
): ClassicTranscriptItem | undefined {
  switch (item.kind) {
    case "user":
      return { kind: "user", id: item.id, text: item.text, done: true };
    case "assistant":
      return {
        kind: "assistant",
        id: item.id,
        text: item.text,
        streaming: false,
        done: true,
      };
    case "thinking":
      return {
        kind: "thinking",
        id: item.id,
        content: item.content,
        done: true,
        startedAt: item.startedAt,
        endedAt: item.endedAt,
      };
    case "tool": {
      const output = persistedToolOutput(item, resolveToolOutput(item));
      const durationMs =
        item.endedAt !== undefined && item.timestamp !== undefined
          ? Math.max(0, item.endedAt - item.timestamp)
          : undefined;
      return {
        kind: "tool",
        id: item.id,
        name: item.name,
        argsDisplay: item.argsDisplay,
        output,
        status:
          item.status === "failed" || item.status === "fail"
            ? "fail"
            : item.status === "running" || item.status === "queued"
              ? "ok"
              : item.status,
        exitCode: item.exitCode,
        summary: item.summary,
        artifactPath: item.artifactPath,
        ...(item.fileChanges ? { fileChanges: item.fileChanges } : {}),
        timestamp: item.timestamp,
        endedAt: item.endedAt,
        ...(durationMs !== undefined ? { durationMs } : {}),
        done: true,
      };
    }
    case "notice":
      return undefined;
    case "turn-summary":
      return {
        kind: "turn-summary",
        id: item.id,
        durationMs: item.durationMs,
        status: item.status,
        timestamp: item.timestamp,
        ...(item.changes ? { changes: item.changes } : {}),
        ...(item.generation ? { generation: item.generation } : {}),
        done: true,
      };
    case "compacted":
      return {
        kind: "compacted",
        id: item.id,
        summary: item.summary,
        originalItems: [],
        done: true,
        beforeTokens: item.beforeTokens,
        afterTokens: item.afterTokens,
        ...(item.measurement ? { measurement: item.measurement } : {}),
        startedAt: item.startedAt,
        endedAt: item.endedAt,
        ...(item.error ? { error: item.error } : {}),
      };
    default:
      return undefined;
  }
}

const ARTIFACT_TOOL_OUTPUT_TAIL_CHARS = 4_000;
const serializedItems = new WeakMap<AnyTranscriptItem, ClassicTranscriptItem>();

function persistedToolOutput(item: AnyTranscriptItem, output: string): string {
  if (item.kind !== "tool") return output;
  const artifactPath = (item as { artifactPath?: unknown }).artifactPath;
  if (
    typeof artifactPath !== "string" ||
    artifactPath.length === 0 ||
    output.length <= ARTIFACT_TOOL_OUTPUT_TAIL_CHARS
  ) {
    return output;
  }
  return output.slice(output.length - ARTIFACT_TOOL_OUTPUT_TAIL_CHARS);
}

export function serializeForHistory(
  state: TranscriptState,
  toolOutput: (toolCallId: ToolCallId) => string,
): ClassicTranscriptItem[] {
  const resolveToolOutput = (item: AnyTranscriptItem): string => {
    if (item.kind !== "tool") return "";
    const live =
      "toolCallId" in item && typeof item.toolCallId === "string"
        ? toolOutput(item.toolCallId as ToolCallId)
        : "";
    if (live) return live;
    return typeof (item as { output?: unknown }).output === "string"
      ? ((item as { output?: string }).output ?? "")
      : "";
  };
  const items: AnyTranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item) items.push(item);
  }
  const out: ClassicTranscriptItem[] = [];
  for (const item of flattenTranscriptHistory(items)) {
    const reusable = item.kind !== "tool";
    const serialized = (reusable ? serializedItems.get(item) : undefined)
      ?? serializeTranscriptItem(item, resolveToolOutput);
    if (!serialized) continue;
    if (reusable) serializedItems.set(item, serialized);
    out.push(serialized);
  }
  return out;
}

export function displayCompactSummary(summary: string): string {
  const prefixes = [
    "Session memory from compacted earlier turns:\n\n",
    "Session memory from compacted earlier turns:",
    "Session memory\n\n",
  ];
  let text = summary;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text.trim();
}
