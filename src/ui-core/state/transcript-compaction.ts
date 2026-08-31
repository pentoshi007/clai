
import type { ToolCallId } from "../../app/events/app-event.js";
import {
  transcriptItems,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript-types.js";

function compactField(value: string): string {
  return value;
}

export type ToolOutputLookup = (toolCallId: ToolCallId) => string;

export function serializeTranscriptForCompaction(
  state: TranscriptState,
  toolOutput?: ToolOutputLookup,
): string {
  const items = transcriptItems(state);
  const lastCompactedIndex = items.map((i) => i.kind).lastIndexOf("compacted");
  const slice =
    lastCompactedIndex !== -1 ? items.slice(lastCompactedIndex) : items;

  return slice
    .map((item) => serializeItem(item, toolOutput))
    .filter((part): part is string => Boolean(part))
    .join("\n\n---\n\n");
}

function serializeItem(
  item: TranscriptItem,
  toolOutput: ToolOutputLookup | undefined,
): string | undefined {
  switch (item.kind) {
    case "user":
      return `USER INTENT/PROMPT:\n${compactField(item.text)}`;
    case "assistant":
      return item.text.trim()
        ? `ASSISTANT RESPONSE:\n${compactField(item.text)}`
        : undefined;
    case "thinking":
      return undefined;
    case "tool": {
      const output = toolOutput?.(item.toolCallId) ?? "";
      return [
        `TOOL/COMMAND: ${item.name}`,
        `INPUT: ${compactField(item.argsDisplay)}`,
        `STATUS: ${item.status}${typeof item.exitCode === "number" ? ` (exit ${item.exitCode})` : ""}`,
        item.summary ? `RESULT SUMMARY: ${compactField(item.summary)}` : "",
        output ? `OUTPUT/RESULT:\n${compactField(output)}` : "",
        item.artifactPath ? `FULL ARTIFACT: ${item.artifactPath}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "notice":
      return undefined;
    case "compacted":
      return `COMPACTED CONTEXT:\n${compactField(item.summary)}`;
    case "turn-summary":
      return undefined;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}

export function mergeCompactionSourceMaterial(
  sessionTranscript: string | undefined,
  olderModelTurns: string,
): string {
  const visual = sessionTranscript?.trim() ?? "";
  const fromMessages = olderModelTurns.trim();
  if (visual && fromMessages) {
    return `${visual}\n\n---\n\nOLDER MODEL TURNS:\n\n${fromMessages}`;
  }
  return visual || fromMessages;
}
