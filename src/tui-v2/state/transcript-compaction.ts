/**
 * Classic-parity source material for /compact (and auto-compact).
 *
 * Builds a structured plain-text record of the visual transcript so the
 * summarizer sees user prompts, tools (with outputs), assistant answers, and
 * prior compacted memory — not a sparse semantic export that drops tool bodies.
 *
 * When a prior `compacted` card exists, only that card and everything after it
 * are included (the memory already covers earlier turns).
 */

import type { ToolCallId } from "../../app/events/app-event.js";
import {
  transcriptItems,
  type TranscriptItem,
  type TranscriptState,
} from "./transcript-types.js";

const MAX_FIELD_CHARS = 8_000;

function compactField(value: string): string {
  if (value.length <= MAX_FIELD_CHARS) return value;
  return `${value.slice(0, MAX_FIELD_CHARS)}\n…[truncated; full output remains in the session transcript/artifact]`;
}

export type ToolOutputLookup = (toolCallId: ToolCallId) => string;

/**
 * Serialize the live v2 transcript for the compaction summarizer.
 * Prefer this over raw semantic export so tool outputs and prior memory land
 * in the summary prompt.
 */
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
      // Skip reasoning — inflates the summary without continuation value.
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
      // Skip ephemeral UI notices (session resumed, etc.) — not model context.
      return undefined;
    case "compacted":
      return `COMPACTED CONTEXT:\n${compactField(item.summary)}`;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Merge visual session material with older model-history turns so /compact
 * after /history (+ optional new prompts) always sees the full picture.
 */
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
