
import { type ChatMessage } from "../../types.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../app/ports/transcript-item.js";
import { type ToolCallId } from "../../app/events/app-event.js";
import { type TranscriptState } from "./transcript-types.js";
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


export interface BoundedSessionVisualInput {
  readonly transcript: ClassicTranscriptItem[] | undefined;
  readonly messages: ChatMessage[];
  readonly omittedItems: number;
  readonly omittedMessages: number;
}

const VISUAL_TRANSCRIPT_ITEMS = 2_000;
const VISUAL_MESSAGE_ITEMS = 2_000;
const VISUAL_FIELD_CHARS = 32_000;
const VISUAL_TOTAL_CHARS = 8_000_000;

function capVisualField(value: string): string {
  if (value.length <= VISUAL_FIELD_CHARS) return value;
  return `${value.slice(0, VISUAL_FIELD_CHARS)}\n…[older output omitted from initial history view]`;
}

function boundedTranscriptItem(
  item: ClassicTranscriptItem,
): ClassicTranscriptItem {
  switch (item.kind) {
    case "user":
    case "assistant":
      return { ...item, text: capVisualField(item.text) };
    case "thinking":
      return { ...item, content: capVisualField(item.content) };
    case "notice":
      return { ...item, text: capVisualField(item.text) };
    case "tool":
      return {
        ...item,
        argsDisplay: capVisualField(item.argsDisplay),
        output: capVisualField(item.output),
        ...(item.summary
          ? { summary: capVisualField(item.summary) }
          : {}),
        ...(item.fileChanges && item.fileChanges.length <= 20
          ? { fileChanges: item.fileChanges }
          : { fileChanges: undefined }),
      };
    case "compacted":
      return {
        ...item,
        summary: capVisualField(item.summary),
        originalItems: [],
      };
    default:
      return item;
  }
}

export function boundSessionVisualInput(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): BoundedSessionVisualInput {
  const recentMessages = messages.slice(-VISUAL_MESSAGE_ITEMS);
  const boundedMessages: ChatMessage[] = [];
  let messageChars = 0;
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index]!;
    const content = capVisualField(message.content);
    if (boundedMessages.length > 0 && messageChars + content.length > VISUAL_TOTAL_CHARS) {
      break;
    }
    messageChars += content.length;
    boundedMessages.push({
      ...message,
      content,
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              args: { restored: "Arguments available in the full session record" },
              rawArguments: undefined,
            })),
          }
        : {}),
    });
  }
  boundedMessages.reverse();

  const recentTranscript = transcript?.slice(-VISUAL_TRANSCRIPT_ITEMS);
  const boundedTranscript: ClassicTranscriptItem[] = [];
  let transcriptChars = 0;
  if (recentTranscript) {
    for (let index = recentTranscript.length - 1; index >= 0; index -= 1) {
      const item = boundedTranscriptItem(recentTranscript[index]!);
      const size =
        item.kind === "tool"
          ? item.output.length + item.argsDisplay.length
          : item.kind === "thinking"
            ? item.content.length
            : item.kind === "compacted"
              ? item.summary.length
              : item.kind === "plan"
                ? 4_000
                : item.kind === "turn-summary"
                  ? 0
                  : item.text.length;
      if (
        boundedTranscript.length > 0 &&
        transcriptChars + size > VISUAL_TOTAL_CHARS
      ) {
        break;
      }
      transcriptChars += size;
      boundedTranscript.push(item);
    }
    boundedTranscript.reverse();
  }

  return {
    transcript: transcript ? boundedTranscript : undefined,
    messages: boundedMessages,
    omittedItems: Math.max(0, (transcript?.length ?? 0) - boundedTranscript.length),
    omittedMessages: Math.max(0, messages.length - boundedMessages.length),
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

export function serializeForHistory(
  state: TranscriptState,
  toolOutput: (toolCallId: ToolCallId) => string,
): ClassicTranscriptItem[] {
  const out: ClassicTranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (!item) continue;
    switch (item.kind) {
      case "user":
        out.push({ kind: "user", id: item.id, text: item.text, done: true });
        break;
      case "assistant":
        out.push({
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: false,
          done: true,
        });
        break;
      case "thinking":
        out.push({
          kind: "thinking",
          id: item.id,
          content: item.content,
          done: true,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
        });
        break;
      case "tool": {
        const output = toolOutput(item.toolCallId);
        const durationMs =
          item.endedAt !== undefined && item.timestamp !== undefined
            ? Math.max(0, item.endedAt - item.timestamp)
            : undefined;
        out.push({
          kind: "tool",
          id: item.id,
          name: item.name,
          argsDisplay: item.argsDisplay,
          output,
          status:
            item.status === "failed"
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
        });
        break;
      }
      case "notice":
        break;
      case "turn-summary":
        out.push({
          kind: "turn-summary",
          id: item.id,
          durationMs: item.durationMs,
          status: item.status,
          timestamp: item.timestamp,
          done: true,
        });
        break;
      case "compacted":
        out.push({
          kind: "compacted",
          id: item.id,
          summary: item.summary,
          originalItems: [],
          done: true,
          beforeTokens: item.beforeTokens,
          afterTokens: item.afterTokens,
          startedAt: item.startedAt,
          endedAt: item.endedAt,
          ...(item.error ? { error: item.error } : {}),
        });
        break;
      default:
        break;
    }
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
